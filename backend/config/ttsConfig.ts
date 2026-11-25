import path from "path";
import { audioDir, backendRoot } from "./paths";

function readInt(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name];

	if (raw === undefined || raw.trim() === "") return fallback;

	const parsed = Number(raw);

	if (!Number.isFinite(parsed)) {
		console.warn(`[tts] Ignoring invalid ${name}; using ${fallback}`);
		return fallback;
	}

	return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function readBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name];

	if (raw === undefined || raw.trim() === "") return fallback;

	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function readString(name: string, fallback: string): string {
	const raw = process.env[name];

	return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

function resolveCacheDir(raw: string): string {
	return path.isAbsolute(raw) ? raw : path.resolve(backendRoot, raw);
}

const kokoroDtype = readString("KOKORO_DTYPE", "q8");
const allowedDtypes = new Set(["fp32", "fp16", "q8", "q4", "q4f16"]);

if (!allowedDtypes.has(kokoroDtype)) {
	console.warn(`[tts] Unsupported KOKORO_DTYPE=${kokoroDtype}; using q8`);
}

export const ttsConfig = Object.freeze({
	audio: Object.freeze({
		dir: audioDir,
		mp3BitrateKbps: readInt("TTS_MP3_BITRATE_KBPS", 64, 32, 320),
		queueConcurrency: readInt("AUDIO_QUEUE_CONCURRENCY", 2, 1, 16),
		queueMaxSize: readInt("AUDIO_QUEUE_MAX_SIZE", 1000, 1, 100000),
	}),
	edge: Object.freeze({
		voice: readString("EDGE_TTS_VOICE", "en-IN-NeerjaNeural"),
		outputFormat: readString("EDGE_TTS_OUTPUT_FORMAT", "audio-24khz-96kbitrate-mono-mp3"),
		pitch: readString("EDGE_TTS_PITCH", "+2%"),
		rate: readString("EDGE_TTS_RATE", "-10%"),
		volume: readString("EDGE_TTS_VOLUME", "100%"),
		timeoutMs: readInt("EDGE_TTS_TIMEOUT_MS", 20000, 1000, 120000),
		maxRetries: readInt("EDGE_TTS_MAX_RETRIES", 2, 0, 10),
		retryBaseDelayMs: readInt("EDGE_TTS_RETRY_BASE_DELAY_MS", 750, 0, 60000),
		retryMaxDelayMs: readInt("EDGE_TTS_RETRY_MAX_DELAY_MS", 8000, 0, 300000),
		retryBudgetMs: readInt("EDGE_TTS_RETRY_BUDGET_MS", 45000, 0, 600000),
	}),
	kokoro: Object.freeze({
		enabled: readBool("KOKORO_ENABLED", true),
		prewarm: readBool("KOKORO_PREWARM", false),
		modelId: readString("KOKORO_MODEL_ID", "onnx-community/Kokoro-82M-v1.0-ONNX"),
		dtype: (allowedDtypes.has(kokoroDtype) ? kokoroDtype : "q8") as
			| "fp32"
			| "fp16"
			| "q8"
			| "q4"
			| "q4f16",
		device: "cpu" as const,
		voice: readString("KOKORO_VOICE", "af_heart"),
		speed: Number(readString("KOKORO_SPEED", "1")) || 1,
		cacheDir: resolveCacheDir(readString("KOKORO_CACHE_DIR", ".cache/kokoro")),
		cooldownMs: readInt("KOKORO_COOLDOWN_MS", 300000, 1000, 3600000),
		failureThreshold: readInt("KOKORO_FAILURE_THRESHOLD", 3, 1, 100),
	}),
});
