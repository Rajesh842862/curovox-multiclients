import path from "path";
import { ttsConfig } from "../config/ttsConfig";
import { EdgeTtsEngine } from "./edgeTtsEngine";
import { KokoroTtsEngine } from "./kokoroEngine";
import { assertValidMp3, publishMp3Buffer, readValidMp3 } from "./mp3";
import {
	classifyEdgeError,
	computeBackoffDelay,
	defaultTtsLogger,
	TtsEngineError,
	TtsGenerationError,
	TtsPublishError,
	type EdgeErrorClassification,
	type TtsLogger,
} from "./ttsErrors";

export interface AudioEngine {
	readonly name: string;
	synthesize(text: string): Promise<Buffer>;
}

export interface RetryOptions {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	budgetMs: number;
}

export interface AudioTtsServiceOptions {
	audioDir: string;
	edge: AudioEngine;
	kokoro: AudioEngine | null;
	retry: RetryOptions;
	logger?: TtsLogger;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
}

export interface GenerateAudioResult {
	filePath: string;
	engine: string;
	edgeAttempts: number;
}

type EdgeAttemptResult =
	| { ok: true; result: GenerateAudioResult }
	| { ok: false; failure: EdgeErrorClassification; attempts: number };

type KokoroAttemptResult =
	| { ok: true; result: GenerateAudioResult }
	| { ok: false; failure: string };

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const sanitizeFilenameSegment = (value: string): string => {
	return value
		.replace(/[\\/]/g, "_")
		.replace(/\.\./g, "")
		.replace(/\s+/g, " ")
		.trim();
};

const isRoom = (placeType?: string): boolean => placeType?.trim().toLowerCase() === "room";

export function generateAudioFilename<T extends { toString: () => string }>(
	roomNumber: T,
	device_type: T,
	call_type: T,
	placeType?: T
): string {
	const room = sanitizeFilenameSegment(roomNumber.toString());
	const device = sanitizeFilenameSegment(device_type.toString());
	const call = sanitizeFilenameSegment(call_type.toString());

	if (isRoom(placeType?.toString())) return `${room}_${device}_${call}.mp3`;

	return `${room}_${call}.mp3`;
}

export function buildSpeechText(
	roomNumber: string,
	call_type: string,
	device_type: string,
	placeType?: string
): string {
	if (!isRoom(placeType)) return `${roomNumber} ${call_type}`;

	const cleanRoom = roomNumber.replace(/^[A-Za-z]+/, "");
	const noLeadingZero = cleanRoom.replace(/^0+/, "") || "0";
	const digits = noLeadingZero.split("").join(" ");

	if (call_type.toLowerCase() === "emergency") {
		return `${digits} ${device_type}`;
	}

	return `${digits} ${device_type} ${call_type}`;
}

function validateAlertContext(roomNumber: string, call_type: string, device_type: string): void {
	if (!roomNumber)
		throw new TtsEngineError("Room number is missing", {
			engine: "edge",
			category: "invalid-input",
			retryable: false,
		});
	if (!call_type)
		throw new TtsEngineError("Call type is missing", {
			engine: "edge",
			category: "invalid-input",
			retryable: false,
		});
	if (!device_type)
		throw new TtsEngineError("Device type is missing", {
			engine: "edge",
			category: "invalid-input",
			retryable: false,
		});
}

/**
 * Edge is the primary engine. Only transient/retryable Edge errors are retried;
 * permanent errors fall straight through to Kokoro. Both engines produce bytes
 * that must pass MP3 validation before they can replace the public file.
 */
export class AudioTtsService {
	private readonly audioDir: string;
	private readonly edge: AudioEngine;
	private readonly kokoro: AudioEngine | null;
	private readonly retry: RetryOptions;
	private readonly logger: TtsLogger;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly random: () => number;

	constructor(options: AudioTtsServiceOptions) {
		this.audioDir = options.audioDir;
		this.edge = options.edge;
		this.kokoro = options.kokoro;
		this.retry = options.retry;
		this.logger = options.logger ?? defaultTtsLogger;
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? defaultSleep;
		this.random = options.random ?? Math.random;
	}

	async audioFileIsReady(
		roomNumber: string,
		device_type: string,
		call_type: string,
		placeType: string
	): Promise<boolean> {
		const filename = generateAudioFilename(roomNumber, device_type, call_type, placeType);
		const info = await readValidMp3(path.join(this.audioDir, filename));

		return info !== undefined;
	}

	async generate(
		roomNumber: string,
		call_type: string,
		device_type: string,
		placeType: string
	): Promise<string> {
		const result = await this.generateWithDetails(roomNumber, call_type, device_type, placeType);

		return result.filePath;
	}

	async generateWithDetails(
		roomNumber: string,
		call_type: string,
		device_type: string,
		placeType: string
	): Promise<GenerateAudioResult> {
		validateAlertContext(roomNumber, call_type, device_type);

		const filename = generateAudioFilename(roomNumber, device_type, call_type, placeType);
		const filePath = path.join(this.audioDir, filename);
		const ready = await this.audioFileIsReady(roomNumber, device_type, call_type, placeType);

		if (ready) {
			this.logger.info(`[tts] Reusing valid audio ${filename}`);
			return { filePath, engine: "existing", edgeAttempts: 0 };
		}

		const text = buildSpeechText(roomNumber, call_type, device_type, placeType);
		const context = `room=${roomNumber} device=${device_type} call=${call_type}`;
		const edgeResult = await this.tryEdge(text, context, filename, filePath);

		if (edgeResult.ok) return edgeResult.result;

		const kokoroResult = await this.tryKokoro(
			text,
			context,
			filename,
			filePath,
			edgeResult.failure,
			edgeResult.attempts
		);

		if (kokoroResult.ok) return kokoroResult.result;

		throw new TtsGenerationError(
			`Audio generation failed for ${context}: Edge TTS failed ` +
				`(category=${edgeResult.failure.category}, reason=${edgeResult.failure.reason}); ` +
				`Kokoro fallback failed (${kokoroResult.failure})`,
			edgeResult.failure,
			kokoroResult.failure
		);
	}

	private async tryEdge(
		text: string,
		context: string,
		filename: string,
		filePath: string
	): Promise<EdgeAttemptResult> {
		const maxAttempts = this.retry.maxRetries + 1;
		const startedAt = this.now();
		let attempts = 0;
		let lastFailure: EdgeErrorClassification = {
			category: "unknown",
			retryable: false,
			reason: "Edge TTS was not attempted",
		};

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			attempts = attempt;
			const attemptStartedAt = this.now();

			try {
				this.logger.info(`[tts] Edge attempt ${attempt}/${maxAttempts} ${context}`);

				const buffer = await this.edge.synthesize(text);

				assertValidMp3(buffer);
				await publishMp3Buffer(this.audioDir, filename, buffer);

				this.logger.info(
					`[tts] Published engine=edge ${context} attempt=${attempt} ` +
						`bytes=${buffer.length} elapsedMs=${this.now() - attemptStartedAt}`
				);

				return {
					ok: true,
					result: { filePath, engine: "edge", edgeAttempts: attempt },
				};
			} catch (error) {
				if (error instanceof TtsPublishError) throw error;

				lastFailure = classifyEdgeError(error);

				this.logger.warn(
					`[tts] Edge attempt ${attempt}/${maxAttempts} failed ` +
						`category=${lastFailure.category} retryable=${lastFailure.retryable} ` +
						`status=${lastFailure.statusCode ?? "n/a"} reason=${lastFailure.reason}`
				);

				if (!lastFailure.retryable || attempt >= maxAttempts) break;

				const delayMs =
					lastFailure.retryAfterMs ??
					computeBackoffDelay(
						attempt,
						this.retry.baseDelayMs,
						this.retry.maxDelayMs,
						this.random
					);
				const elapsedMs = this.now() - startedAt;

				if (elapsedMs + delayMs > this.retry.budgetMs) {
					this.logger.warn(
						`[tts] Edge retry budget exhausted after ${elapsedMs}ms; ` +
							`next delay ${delayMs}ms would exceed ${this.retry.budgetMs}ms`
					);
					break;
				}

				this.logger.info(
					`[tts] Edge retrying in ${delayMs}ms ` +
						`(reason=${lastFailure.retryAfterMs !== undefined ? "retry-after" : "backoff"})`
				);

				await this.sleep(delayMs);
			}
		}

		this.logger.warn(
			`[tts] Edge exhausted after ${this.now() - startedAt}ms ` +
				`category=${lastFailure.category}; trying Kokoro fallback`
		);

		return { ok: false, failure: lastFailure, attempts };
	}

	private async tryKokoro(
		text: string,
		context: string,
		filename: string,
		filePath: string,
		edgeFailure: EdgeErrorClassification,
		edgeAttempts: number
	): Promise<KokoroAttemptResult> {
		if (!this.kokoro) return { ok: false, failure: "fallback is not configured" };

		const startedAt = this.now();

		try {
			this.logger.warn(
				`[tts] Kokoro fallback start ${context} edgeCategory=${edgeFailure.category}`
			);

			const buffer = await this.kokoro.synthesize(text);

			assertValidMp3(buffer);
			await publishMp3Buffer(this.audioDir, filename, buffer);

			this.logger.info(
				`[tts] Published engine=kokoro ${context} bytes=${buffer.length} ` +
					`elapsedMs=${this.now() - startedAt}`
			);

			return {
				ok: true,
				result: { filePath, engine: "kokoro", edgeAttempts },
			};
		} catch (error) {
			if (error instanceof TtsPublishError) throw error;

			const message =
				error instanceof TtsEngineError
					? `${error.category}: ${error.message}`
					: (error as Error).message || String(error);

			this.logger.error(`[tts] Kokoro fallback failed ${context}: ${message}`);

			return { ok: false, failure: message };
		}
	}
}

const defaultKokoroEngine = new KokoroTtsEngine({
	enabled: ttsConfig.kokoro.enabled,
	modelId: ttsConfig.kokoro.modelId,
	dtype: ttsConfig.kokoro.dtype,
	device: ttsConfig.kokoro.device,
	voice: ttsConfig.kokoro.voice,
	speed: ttsConfig.kokoro.speed,
	cacheDir: ttsConfig.kokoro.cacheDir,
	cooldownMs: ttsConfig.kokoro.cooldownMs,
	failureThreshold: ttsConfig.kokoro.failureThreshold,
	bitrateKbps: ttsConfig.audio.mp3BitrateKbps,
});

const defaultService = new AudioTtsService({
	audioDir: ttsConfig.audio.dir,
	edge: new EdgeTtsEngine({
		voice: ttsConfig.edge.voice,
		outputFormat: ttsConfig.edge.outputFormat,
		pitch: ttsConfig.edge.pitch,
		rate: ttsConfig.edge.rate,
		volume: ttsConfig.edge.volume,
		timeoutMs: ttsConfig.edge.timeoutMs,
		tempDir: path.join(ttsConfig.audio.dir, ".tmp"),
	}),
	kokoro: defaultKokoroEngine,
	retry: {
		maxRetries: ttsConfig.edge.maxRetries,
		baseDelayMs: ttsConfig.edge.retryBaseDelayMs,
		maxDelayMs: ttsConfig.edge.retryMaxDelayMs,
		budgetMs: ttsConfig.edge.retryBudgetMs,
	},
});

export async function generate(
	roomNumber: string,
	call_type: string,
	device_type: string,
	placeType: string
): Promise<string> {
	return defaultService.generate(roomNumber, call_type, device_type, placeType);
}

export async function audioFileIsReady<T extends { toString: () => string }>(
	roomNumber: T,
	device_type: T,
	call_type: T,
	placeType: T
): Promise<boolean> {
	return defaultService.audioFileIsReady(
		roomNumber.toString(),
		device_type.toString(),
		call_type.toString(),
		placeType.toString()
	);
}

export async function warmKokoro(): Promise<void> {
	if (!ttsConfig.kokoro.enabled) return;

	await defaultKokoroEngine.warm();
}

export default generate;
