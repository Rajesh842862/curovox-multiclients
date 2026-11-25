import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { EdgeTTS } from "node-edge-tts";
import { defaultTtsLogger, type TtsLogger } from "./ttsErrors";

export interface EdgeTtsEngineOptions {
	voice: string;
	outputFormat: string;
	pitch: string;
	rate: string;
	volume: string;
	timeoutMs: number;
	tempDir: string;
}

/**
 * Writes to a unique temporary file and returns the bytes. The caller validates
 * and publishes atomically, so an interrupted Edge synthesis can never replace a
 * previously valid MP3.
 */
export class EdgeTtsEngine {
	readonly name = "edge";

	private readonly options: EdgeTtsEngineOptions;
	private readonly logger: TtsLogger;

	constructor(options: EdgeTtsEngineOptions, logger: TtsLogger = defaultTtsLogger) {
		this.options = options;
		this.logger = logger;
	}

	async synthesize(text: string): Promise<Buffer> {
		await fs.mkdir(this.options.tempDir, { recursive: true });

		const tempPath = path.join(
			this.options.tempDir,
			`.edge-${process.pid}-${crypto.randomBytes(8).toString("hex")}.mp3`
		);

		try {
			const tts = new EdgeTTS({
				voice: this.options.voice,
				outputFormat: this.options.outputFormat,
				pitch: this.options.pitch,
				rate: this.options.rate,
				volume: this.options.volume,
				timeout: this.options.timeoutMs,
			});

			await tts.ttsPromise(text, tempPath);

			const stat = await fs.stat(tempPath);

			if (stat.size === 0) {
				throw new Error("Edge TTS produced an empty file");
			}

			return await fs.readFile(tempPath);
		} finally {
			// On a library timeout the internal write stream may still be open.
			// A best-effort unlink is safe because every attempt has a unique path.
			await fs.rm(tempPath, { force: true }).catch((error) => {
				this.logger.warn(
					`[tts] Could not remove Edge temp file ${path.basename(tempPath)}: ${
						(error as Error).message
					}`
				);
			});
		}
	}
}
