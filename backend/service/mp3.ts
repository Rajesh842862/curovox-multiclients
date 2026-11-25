import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { TtsAudioValidationError, TtsPublishError } from "./ttsErrors";
import { importEsm } from "./esmLoader";

type LameModule = typeof import("@breezystack/lamejs");

let lameModulePromise: Promise<LameModule> | undefined;

function loadLameModule(): Promise<LameModule> {
	if (!lameModulePromise) {
		lameModulePromise = importEsm<LameModule>("@breezystack/lamejs").catch((error) => {
			lameModulePromise = undefined;
			throw error;
		});
	}

	return lameModulePromise;
}

const MP3_SAMPLE_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

export interface Mp3Info {
	frames: number;
	version: "MPEG-1" | "MPEG-2" | "MPEG-2.5";
	layer: "Layer III";
	bitrateKbps: number;
	sampleRateHz: number;
	durationSeconds: number;
	bytes: number;
	id3TagBytes: number;
}

interface ParsedFrame {
	frameLength: number;
	bitrateKbps: number;
	sampleRateHz: number;
	samplesPerFrame: number;
	version: "MPEG-1" | "MPEG-2" | "MPEG-2.5";
	layer: "Layer III";
}

function readSyncSafeSize(buffer: Buffer, offset: number): number {
	return (
		((buffer[offset] & 0x7f) << 21) |
		((buffer[offset + 1] & 0x7f) << 14) |
		((buffer[offset + 2] & 0x7f) << 7) |
		(buffer[offset + 3] & 0x7f)
	);
}

function getId3TagBytes(buffer: Buffer): number {
	if (buffer.length < 10 || buffer.subarray(0, 3).toString("ascii") !== "ID3") return 0;

	const tagSize = readSyncSafeSize(buffer, 6);
	const hasFooter = (buffer[5] & 0x10) !== 0;

	return 10 + tagSize + (hasFooter ? 10 : 0);
}

function parseFrameHeader(buffer: Buffer, offset: number): ParsedFrame | undefined {
	if (offset < 0 || offset + 4 > buffer.length) return undefined;

	const byte1 = buffer[offset + 1];
	const byte2 = buffer[offset + 2];

	if (buffer[offset] !== 0xff || (byte1 & 0xe0) !== 0xe0) return undefined;

	const versionBits = (byte1 >> 3) & 0x03;
	const layerBits = (byte1 >> 1) & 0x03;
	const bitrateIndex = (byte2 >> 4) & 0x0f;
	const sampleRateIndex = (byte2 >> 2) & 0x03;
	const padding = (byte2 >> 1) & 0x01;

	if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15) {
		return undefined;
	}

	if (sampleRateIndex === 3) return undefined;

	const version = versionBits === 3 ? "MPEG-1" : versionBits === 2 ? "MPEG-2" : "MPEG-2.5";
	const bitrateTable = version === "MPEG-1" ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES;
	const bitrateKbps = bitrateTable[bitrateIndex];
	const sampleRateTable =
		version === "MPEG-1" ? [44100, 48000, 32000] : version === "MPEG-2" ? [22050, 24000, 16000] : [11025, 12000, 8000];
	const sampleRateHz = sampleRateTable[sampleRateIndex];

	if (!bitrateKbps || !sampleRateHz) return undefined;

	const samplesPerFrame = version === "MPEG-1" ? 1152 : 576;
	const frameLength =
		Math.floor(((version === "MPEG-1" ? 144000 : 72000) * bitrateKbps) / sampleRateHz) + padding;

	if (frameLength <= 4) return undefined;

	return {
		frameLength,
		bitrateKbps,
		sampleRateHz,
		samplesPerFrame,
		version,
		layer: "Layer III",
	};
}

function findFirstFrame(buffer: Buffer, startOffset: number): number | undefined {
	const limit = Math.min(buffer.length - 4, startOffset + 4096);

	for (let offset = startOffset; offset <= limit; offset++) {
		if (parseFrameHeader(buffer, offset)) return offset;
	}

	return undefined;
}

export function inspectMp3(buffer: Buffer): Mp3Info | undefined {
	if (!Buffer.isBuffer(buffer) || buffer.length < 128) return undefined;

	const id3TagBytes = getId3TagBytes(buffer);

	if (id3TagBytes >= buffer.length) return undefined;

	const firstFrame = findFirstFrame(buffer, id3TagBytes);

	if (firstFrame === undefined) return undefined;

	let offset = firstFrame;
	let frames = 0;
	let durationSeconds = 0;
	let first: ParsedFrame | undefined;

	while (offset + 4 <= buffer.length && frames < 100000) {
		// A trailing ID3v1 tag is common and is not part of the audio stream.
		if (
			offset + 128 === buffer.length &&
			buffer.subarray(offset, offset + 3).toString("ascii") === "TAG"
		) {
			offset += 128;
			break;
		}

		const frame = parseFrameHeader(buffer, offset);

		if (!frame || offset + frame.frameLength > buffer.length) return undefined;

		if (!first) first = frame;

		frames += 1;
		durationSeconds += frame.samplesPerFrame / frame.sampleRateHz;
		offset += frame.frameLength;
	}

	if (!first || frames === 0 || offset !== buffer.length) return undefined;

	return {
		frames,
		version: first.version,
		layer: first.layer,
		bitrateKbps: first.bitrateKbps,
		sampleRateHz: first.sampleRateHz,
		durationSeconds: Number(durationSeconds.toFixed(3)),
		bytes: buffer.length,
		id3TagBytes,
	};
}

export function assertValidMp3(buffer: Buffer): Mp3Info {
	const info = inspectMp3(buffer);

	if (!info) {
		throw new TtsAudioValidationError("no complete MPEG Layer III audio frames were found");
	}

	return info;
}

export async function encodePcmToMp3(
	samples: Float32Array,
	sampleRate: number,
	bitrateKbps: number
): Promise<Buffer> {
	if (!(samples instanceof Float32Array) || samples.length === 0) {
		throw new TtsAudioValidationError("Kokoro returned no PCM samples");
	}

	if (!MP3_SAMPLE_RATES.has(sampleRate)) {
		throw new TtsAudioValidationError(`unsupported MP3 sample rate ${sampleRate}Hz`);
	}

	const lame = await loadLameModule();
	const encoder = new lame.Mp3Encoder(1, sampleRate, bitrateKbps);
	const pcm = new Int16Array(samples.length);

	for (let index = 0; index < samples.length; index++) {
		const sample = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;

		pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
	}

	const chunks: Buffer[] = [];

	for (let offset = 0; offset < pcm.length; offset += 1152) {
		const chunk = encoder.encodeBuffer(pcm.subarray(offset, offset + 1152));

		if (chunk.length > 0) chunks.push(Buffer.from(chunk));
	}

	const flushed = encoder.flush();

	if (flushed.length > 0) chunks.push(Buffer.from(flushed));

	const output = Buffer.concat(chunks);

	assertValidMp3(output);

	return output;
}

async function replaceFile(tempPath: string, targetPath: string): Promise<void> {
	try {
		await fs.rename(tempPath, targetPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;

		if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;

		// Windows can refuse to replace an existing destination. Removing the old
		// file is only done after the new file is already complete and validated.
		await fs.rm(targetPath, { force: true });
		await fs.rename(tempPath, targetPath);
	}
}

export async function publishMp3Buffer(
	audioDir: string,
	filename: string,
	buffer: Buffer
): Promise<string> {
	if (path.basename(filename) !== filename) {
		throw new TtsPublishError("Refusing to publish an audio file outside the audio directory");
	}

	assertValidMp3(buffer);

	const filePath = path.join(audioDir, filename);
	const tempPath = path.join(
		audioDir,
		`.${filename}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
	);

	try {
		await fs.mkdir(audioDir, { recursive: true });
		await fs.writeFile(tempPath, buffer, { flag: "wx" });
		await replaceFile(tempPath, filePath);
	} catch (error) {
		throw new TtsPublishError(
			`Failed to publish ${filename}: ${(error as Error).message}`,
			error
		);
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
	}

	return filePath;
}

export async function readValidMp3(filePath: string): Promise<Mp3Info | undefined> {
	try {
		const buffer = await fs.readFile(filePath);

		return inspectMp3(buffer);
	} catch {
		return undefined;
	}
}
