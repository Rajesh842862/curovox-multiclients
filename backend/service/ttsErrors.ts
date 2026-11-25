export type TtsEngineName = "edge" | "kokoro";

export interface TtsLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export const defaultTtsLogger: TtsLogger = {
	info: (message) => console.log(message),
	warn: (message) => console.warn(message),
	error: (message) => console.error(message),
};

export type TtsErrorCategory =
	| "rate-limit"
	| "server"
	| "network"
	| "timeout"
	| "auth"
	| "client"
	| "invalid-input"
	| "invalid-audio"
	| "cooldown"
	| "disabled"
	| "publish"
	| "unknown";

export interface EdgeErrorClassification {
	category: TtsErrorCategory;
	retryable: boolean;
	statusCode?: number;
	retryAfterMs?: number;
	reason: string;
}

export interface TtsErrorDetails {
	engine: TtsEngineName;
	category: TtsErrorCategory;
	retryable: boolean;
	statusCode?: number;
	retryAfterMs?: number;
	cause?: unknown;
}

export class TtsEngineError extends Error {
	readonly engine: TtsEngineName;
	readonly category: TtsErrorCategory;
	readonly retryable: boolean;
	readonly statusCode?: number;
	readonly retryAfterMs?: number;
	readonly cause?: unknown;

	constructor(message: string, details: TtsErrorDetails) {
		super(message);
		this.name = "TtsEngineError";
		this.engine = details.engine;
		this.category = details.category;
		this.retryable = details.retryable;
		this.statusCode = details.statusCode;
		this.retryAfterMs = details.retryAfterMs;
		this.cause = details.cause;
	}
}

export class TtsAudioValidationError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`Invalid MP3 audio: ${reason}`);
		this.name = "TtsAudioValidationError";
		this.reason = reason;
	}
}

export class TtsPublishError extends Error {
	readonly cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "TtsPublishError";
		this.cause = cause;
	}
}

export class TtsGenerationError extends Error {
	readonly edgeFailure: EdgeErrorClassification;
	readonly kokoroFailure?: string;

	constructor(message: string, edgeFailure: EdgeErrorClassification, kokoroFailure?: string) {
		super(message);
		this.name = "TtsGenerationError";
		this.edgeFailure = edgeFailure;
		this.kokoroFailure = kokoroFailure;
	}
}

interface ErrorLike {
	message?: unknown;
	code?: unknown;
	status?: unknown;
	statusCode?: unknown;
	retryAfter?: unknown;
	retryAfterMs?: unknown;
	headers?: unknown;
}

const NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENETDOWN",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

const NETWORK_MESSAGES = [
	"socket hang up",
	"network error",
	"network is unreachable",
	"connection reset",
	"connection refused",
	"connection timed out",
	"temporary failure in name resolution",
	"getaddrinfo",
	"tls handshake timeout",
];

const TIMEOUT_MESSAGES = ["timed out", "timeout", "etimedout"];

const AUTH_MESSAGES = ["unauthorized", "forbidden", "authentication", "invalid subscription key"];

const INVALID_INPUT_MESSAGES = [
	"room number is missing",
	"call type is missing",
	"device type is missing",
	"invalid voice",
	"voice not found",
];

function toErrorLike(error: unknown): ErrorLike {
	if (typeof error === "object" && error !== null) return error as ErrorLike;

	return {};
}

function getErrorMessage(error: unknown): string {
	if (typeof error === "string") return error;

	const message = toErrorLike(error).message;

	return typeof message === "string" ? message : String(error);
}

function getStatusCode(error: unknown): number | undefined {
	const err = toErrorLike(error);
	const candidates = [err.status, err.statusCode, err.code];

	for (const candidate of candidates) {
		const value = typeof candidate === "string" ? Number(candidate) : candidate;

		if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
			return value;
		}
	}

	const message = getErrorMessage(error);
	const patterns = [
		/unexpected server response:\s*(\d{3})/i,
		/status(?:\s*code)?[:\s]+(\d{3})/i,
		/http(?:\s*error)?[:\s]+(\d{3})/i,
		/response code[:\s]+(\d{3})/i,
	];

	for (const pattern of patterns) {
		const match = message.match(pattern);

		if (!match) continue;

		const parsed = Number(match[1]);

		if (parsed >= 100 && parsed <= 599) return parsed;
	}

	return undefined;
}

export function parseRetryAfterMs(value: unknown, now = Date.now()): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;

	const numeric = typeof value === "number" ? value : Number(value);

	if (typeof value !== "string" || /^\d+(?:\.\d+)?$/.test(value.trim())) {
		if (Number.isFinite(numeric) && numeric >= 0) {
			return Math.round(numeric * 1000);
		}
	}

	const dateValue = typeof value === "string" ? Date.parse(value) : Number.NaN;

	if (Number.isFinite(dateValue)) {
		return Math.max(0, dateValue - now);
	}

	return undefined;
}

function getRetryAfterMs(error: unknown, now: number): number | undefined {
	const err = toErrorLike(error);
	const explicitMs = err.retryAfterMs;

	if (typeof explicitMs === "number" && Number.isFinite(explicitMs) && explicitMs >= 0) {
		return Math.round(explicitMs);
	}

	if (typeof explicitMs === "string") {
		const parsed = Number(explicitMs);

		if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
	}

	const fromProperty = parseRetryAfterMs(err.retryAfter, now);

	if (fromProperty !== undefined) return fromProperty;

	if (typeof err.headers === "object" && err.headers !== null) {
		const headers = err.headers as Record<string, unknown> & {
			get?: (name: string) => unknown;
		};
		const raw =
			headers["retry-after"] ??
			headers["Retry-After"] ??
			(typeof headers.get === "function" ? headers.get("retry-after") : undefined);
		const fromHeader = parseRetryAfterMs(raw, now);

		if (fromHeader !== undefined) return fromHeader;
	}

	const message = getErrorMessage(error);
	const fromMessage = message.match(/retry-after[:\s]+([^\r\n;,]+)/i);

	if (fromMessage) return parseRetryAfterMs(fromMessage[1].trim(), now);

	return undefined;
}

export function classifyEdgeError(error: unknown, now = Date.now()): EdgeErrorClassification {
	const message = getErrorMessage(error);
	const lower = message.toLowerCase();
	const statusCode = getStatusCode(error);
	const retryAfterMs = getRetryAfterMs(error, now);

	if (error instanceof TtsAudioValidationError) {
		return {
			category: "invalid-audio",
			retryable: true,
			reason: error.reason,
		};
	}

	if (statusCode !== undefined) {
		if (statusCode === 429) {
			return {
				category: "rate-limit",
				retryable: true,
				statusCode,
				retryAfterMs,
				reason: "HTTP 429",
			};
		}

		if (statusCode === 408 || statusCode === 425 || (statusCode >= 500 && statusCode <= 599)) {
			return {
				category: statusCode >= 500 ? "server" : "timeout",
				retryable: true,
				statusCode,
				retryAfterMs,
				reason: `HTTP ${statusCode}`,
			};
		}

		if (statusCode === 401 || statusCode === 403) {
			return {
				category: "auth",
				retryable: false,
				statusCode,
				reason: `HTTP ${statusCode}`,
			};
		}

		if (statusCode >= 400 && statusCode <= 499) {
			return {
				category: "client",
				retryable: false,
				statusCode,
				reason: `HTTP ${statusCode}`,
			};
		}
	}

	const code = toErrorLike(error).code;

	if (typeof code === "string" && NETWORK_CODES.has(code.toUpperCase())) {
		return {
			category: "network",
			retryable: true,
			reason: code,
		};
	}

	if (NETWORK_MESSAGES.some((pattern) => lower.includes(pattern))) {
		return {
			category: "network",
			retryable: true,
			reason: message,
		};
	}

	if (TIMEOUT_MESSAGES.some((pattern) => lower.includes(pattern))) {
		return {
			category: "timeout",
			retryable: true,
			reason: message,
		};
	}

	if (AUTH_MESSAGES.some((pattern) => lower.includes(pattern))) {
		return {
			category: "auth",
			retryable: false,
			reason: message,
		};
	}

	if (INVALID_INPUT_MESSAGES.some((pattern) => lower.includes(pattern))) {
		return {
			category: "invalid-input",
			retryable: false,
			reason: message,
		};
	}

	return {
		category: "unknown",
		retryable: false,
		reason: message || "Unknown Edge TTS error",
	};
}

export function computeBackoffDelay(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	random: () => number = Math.random
): number {
	const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));

	// Equal jitter keeps a predictable lower bound while spreading retries.
	return Math.round(exponential / 2 + random() * (exponential / 2));
}
