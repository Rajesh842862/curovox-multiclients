import fs from "fs/promises";
import { encodePcmToMp3 } from "./mp3";
import { importEsm } from "./esmLoader";
import {
	defaultTtsLogger,
	type TtsLogger,
} from "./ttsErrors";
import { TtsAudioValidationError, TtsEngineError } from "./ttsErrors";

type TransformersModule = typeof import("@huggingface/transformers");
type KokoroModule = typeof import("kokoro-js");

export interface KokoroAudio {
	audio: Float32Array;
	sampling_rate: number;
}

export interface KokoroModel {
	generate(
		text: string,
		options: { voice: string; speed: number }
	): Promise<KokoroAudio>;
}

export type KokoroModelLoader = () => Promise<KokoroModel>;
export type KokoroAudioEncoder = (samples: Float32Array, sampleRate: number) => Promise<Buffer>;

export interface KokoroTtsEngineOptions {
	enabled: boolean;
	modelId: string;
	dtype: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
	device: "cpu";
	voice: string;
	speed: number;
	cacheDir: string;
	cooldownMs: number;
	failureThreshold: number;
	bitrateKbps: number;
}

export interface KokoroTtsEngineDependencies {
	loadModel?: KokoroModelLoader;
	encodeAudio?: KokoroAudioEncoder;
	logger?: TtsLogger;
	now?: () => number;
}

function createDefaultLoader(options: KokoroTtsEngineOptions, logger: TtsLogger): KokoroModelLoader {
	return async () => {
		await fs.mkdir(options.cacheDir, { recursive: true });

		const transformers = await importEsm<TransformersModule>("@huggingface/transformers");

		// Set the persistent cache before Kokoro imports the same transformers
		// module. Without this, the model is cached under node_modules and lost
		// on the next deployment.
		transformers.env.cacheDir = options.cacheDir;

		const { KokoroTTS } = await importEsm<KokoroModule>("kokoro-js");
		const lastLoggedBucket = new Map<string, number>();

		const model = await KokoroTTS.from_pretrained(options.modelId, {
			dtype: options.dtype,
			device: options.device,
			progress_callback: (progress: unknown) => {
				const update = progress as {
					status?: string;
					file?: string;
					progress?: number;
				};

				if (
					update.status !== "progress" ||
					!update.file ||
					typeof update.progress !== "number"
				) {
					return;
				}

				const bucket = Math.floor(update.progress / 20) * 20;
				const previous = lastLoggedBucket.get(update.file) ?? -1;

				if (bucket <= previous || bucket >= 100) return;

				lastLoggedBucket.set(update.file, bucket);
				logger.info(
					`[tts] Kokoro download ${bucket}% ${update.file.split(/[\\/]/).pop() ?? "model"}`
				);
			},
		});

		return model as unknown as KokoroModel;
	};
}

/**
 * Lazily owns one Kokoro model instance for the process. Initialization and
 * inference are single-flight/serialized so concurrent nurse calls cannot load
 * duplicate models or run heavy CPU inference in parallel.
 */
export class KokoroTtsEngine {
	readonly name = "kokoro";

	private readonly options: KokoroTtsEngineOptions;
	private readonly loadModel: KokoroModelLoader;
	private readonly encodeAudio: KokoroAudioEncoder;
	private readonly logger: TtsLogger;
	private readonly now: () => number;

	private instance: KokoroModel | null = null;
	private initializing: Promise<KokoroModel> | null = null;
	private cooldownUntil = 0;
	private consecutiveFailures = 0;
	private inferenceChain: Promise<void> = Promise.resolve();

	constructor(
		options: KokoroTtsEngineOptions,
		dependencies: KokoroTtsEngineDependencies = {}
	) {
		this.options = options;
		this.logger = dependencies.logger ?? defaultTtsLogger;
		this.now = dependencies.now ?? Date.now;
		this.loadModel = dependencies.loadModel ?? createDefaultLoader(options, this.logger);
		this.encodeAudio =
			dependencies.encodeAudio ??
			((samples, sampleRate) =>
				encodePcmToMp3(samples, sampleRate, options.bitrateKbps));
	}

	getStatus(): {
		modelLoaded: boolean;
		cooldownRemainingMs: number;
		consecutiveFailures: number;
	} {
		return {
			modelLoaded: this.instance !== null,
			cooldownRemainingMs: Math.max(0, this.cooldownUntil - this.now()),
			consecutiveFailures: this.consecutiveFailures,
		};
	}

	async warm(): Promise<void> {
		await this.getModel();
	}

	async synthesize(text: string): Promise<Buffer> {
		if (!this.options.enabled) {
			throw new TtsEngineError("Kokoro fallback is disabled", {
				engine: "kokoro",
				category: "disabled",
				retryable: false,
			});
		}

		this.assertNotCoolingDown();
		const model = await this.getModel();

		return this.enqueueInference(async () => {
			this.assertNotCoolingDown();

			const startedAt = this.now();

			try {
				const audio = await model.generate(text, {
					voice: this.options.voice,
					speed: this.options.speed,
				});

				if (!(audio.audio instanceof Float32Array) || audio.audio.length === 0) {
					throw new TtsAudioValidationError("Kokoro returned no audio samples");
				}

				if (!Number.isFinite(audio.sampling_rate) || audio.sampling_rate <= 0) {
					throw new TtsAudioValidationError("Kokoro returned an invalid sample rate");
				}

				const mp3 = await this.encodeAudio(audio.audio, audio.sampling_rate);
				const elapsedMs = this.now() - startedAt;

				this.consecutiveFailures = 0;
				this.logger.info(
					`[tts] Kokoro generated ${mp3.length} bytes in ${elapsedMs}ms ` +
						`(voice=${this.options.voice} sampleRate=${audio.sampling_rate}Hz)`
				);

				return mp3;
			} catch (error) {
				const message = (error as Error).message || String(error);
				const wrapped =
					error instanceof TtsEngineError
						? error
						: new TtsEngineError(`Kokoro synthesis failed: ${message}`, {
								engine: "kokoro",
								category:
									error instanceof TtsAudioValidationError
										? "invalid-audio"
										: "unknown",
								retryable: false,
								cause: error,
							});

				this.recordFailure(wrapped, "inference");
				throw wrapped;
			}
		});
	}

	private assertNotCoolingDown(): void {
		const remaining = this.cooldownUntil - this.now();

		if (remaining > 0) {
			throw new TtsEngineError(
				`Kokoro fallback is cooling down for another ${Math.ceil(remaining / 1000)}s`,
				{
					engine: "kokoro",
					category: "cooldown",
					retryable: false,
				}
			);
		}
	}

	private getModel(): Promise<KokoroModel> {
		if (this.instance) return Promise.resolve(this.instance);
		if (this.initializing) return this.initializing;

		const initializing = this.initialize();
		this.initializing = initializing;

		return initializing.finally(() => {
			if (this.initializing === initializing) this.initializing = null;
		});
	}

	private async initialize(): Promise<KokoroModel> {
		const startedAt = this.now();
		const rssBefore = process.memoryUsage().rss;

		this.logger.info(
			`[tts] Initializing Kokoro model=${this.options.modelId} dtype=${this.options.dtype} ` +
				`device=${this.options.device} cache=${this.options.cacheDir}`
		);

		try {
			const model = await this.loadModel();
			const elapsedMs = this.now() - startedAt;
			const rssAfter = process.memoryUsage().rss;

			this.instance = model;
			this.cooldownUntil = 0;
			this.consecutiveFailures = 0;

			this.logger.info(
				`[tts] Kokoro model ready in ${elapsedMs}ms; ` +
					`RSS ${(rssBefore / 1048576).toFixed(1)}MB -> ${(rssAfter / 1048576).toFixed(1)}MB`
			);

			return model;
		} catch (error) {
			const wrapped = new TtsEngineError(
				`Kokoro model initialization failed: ${(error as Error).message || String(error)}`,
				{
					engine: "kokoro",
					category: "unknown",
					retryable: false,
					cause: error,
				}
			);

			this.recordFailure(wrapped, "initialization");
			throw wrapped;
		}
	}

	private enqueueInference<T>(task: () => Promise<T>): Promise<T> {
		const result = this.inferenceChain.then(task);

		this.inferenceChain = result.then(
			() => undefined,
			() => undefined
		);

		return result;
	}

	private recordFailure(error: TtsEngineError, phase: "initialization" | "inference"): void {
		this.consecutiveFailures += 1;

		if (
			phase === "initialization" ||
			this.consecutiveFailures >= this.options.failureThreshold
		) {
			this.cooldownUntil = this.now() + this.options.cooldownMs;
			this.logger.warn(
				`[tts] Kokoro ${phase} failure (${this.consecutiveFailures} consecutive); ` +
					`cooldown ${Math.round(this.options.cooldownMs / 1000)}s: ${error.message}`
			);
		} else {
			this.logger.warn(
				`[tts] Kokoro ${phase} failure (${this.consecutiveFailures}/` +
					`${this.options.failureThreshold} before cooldown): ${error.message}`
			);
		}
	}
}
