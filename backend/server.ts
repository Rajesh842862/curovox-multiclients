import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { pool, callbackPool } from "./config/db";
import weeklyReportRoutes from "./routes/weeklyReportRoute";
import reportRoutes from "./routes/reportRoute";
import demoRoutes from "./routes/demoRoute";
import generate, {
	audioFileIsReady,
	generateAudioFilename,
	warmKokoro,
} from "./service/ttsService";
import { AudioTaskQueue } from "./service/audioQueue";
import {
	applyAlertEvent,
	isDuplicateActiveAlert,
	isEndCallType,
	sortActiveAlerts,
} from "./service/alertState";
import { ttsConfig } from "./config/ttsConfig";
import { publicDir } from "./config/paths";
import { createGracefulShutdown } from "./service/gracefulShutdown";
import { ActiveAlert, AlertData, NcbEspRow, ServerErrorPayload } from "./types";

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);

app.use(express.json());
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
	res.status(200).json({
		success: true,
	});
});

app.use("/api/report", reportRoutes);
app.use("/api", weeklyReportRoutes);
app.use("/api/demo", demoRoutes);

const server = http.createServer(app);

const io = new Server(server, {
	cors: {
		origin: process.env.FRONTEND_URL,
		methods: ["GET", "POST"],
	},
});

const POLL_INTERVAL_MS = 1000;
const POLL_BATCH_SIZE = 500;

let activeAlerts: ActiveAlert[] = [];
// Last event that was fully applied to activeAlerts. It is never moved to the
// table's maximum sno without processing every event up to that point.
let lastProcessedSno = 0;
let isChecking = false;
let stateReady = false;
let pollerStarted = false;
let shuttingDown = false;
let pollerTimer: NodeJS.Timeout | undefined;

// Serializes polling and reset operations so they cannot mutate activeAlerts
// or the cursor concurrently.
let operationQueue: Promise<void> = Promise.resolve();

const runExclusive = <T>(task: () => Promise<T>): Promise<T> => {
	const result = operationQueue.then(task, task);

	operationQueue = result.then(
		() => undefined,
		() => undefined
	);

	return result;
};

const sendErrorToFrontend = (message: ServerErrorPayload): void => {
	io.emit("server-error", {
		success: false,
		message,
		time: new Date(),
	});
};

const getSortedActiveAlerts = (): ActiveAlert[] => sortActiveAlerts(activeAlerts);

// New calls replace any existing alert for the same room/device. Cancel,
// acknowledged and reset events remove it. This is deliberately idempotent so
// a retried or duplicated event converges to the same state.
const applyEventToState = (row: NcbEspRow): AlertData => {
	const result = applyAlertEvent(activeAlerts, row);

	activeAlerts = result.alerts;

	return result.alertData;
};

type AudioContext = Pick<AlertData, "room" | "callType" | "device_type" | "placeType">;

const reportAudioFailure = (error: Error, alert?: AudioContext): void => {
	const context = alert ? `room=${alert.room} callType=${alert.callType} device=${alert.device_type}: ` : "";

	console.error("Audio generation failed:", `${context}${error.message}`);

	if (error.message === "getaddrinfo ENOTFOUND speech.platform.bing.com") {
		sendErrorToFrontend({
			type: "AUDIO_GENERATION_FAILED",
			message: "Kindly check your internet , audio generate failed!",
			error: error.message,
		});
	} else {
		sendErrorToFrontend({
			type: "AUDIO_GENERATION_FAILED",
			message: error.message,
			error: error.message,
		});
	}
};

// Audio is best-effort and must never delay alert delivery. Both live events and
// restart recovery feed this queue; duplicate keys are coalesced and concurrency
// is bounded so a slow TTS provider cannot grow work without limit.
const audioQueue = new AudioTaskQueue({
	concurrency: ttsConfig.audio.queueConcurrency,
	maxQueueSize: ttsConfig.audio.queueMaxSize,
	onError: (error) => reportAudioFailure(error),
});

const reportAudioDrop = (key: string, alert?: AudioContext): void => {
	const context = alert ? `room=${alert.room} callType=${alert.callType} device=${alert.device_type}: ` : "";

	console.error(
		`Audio queue full; audio skipped for ${context}${key}. The alert remains active.`
	);

	sendErrorToFrontend({
		type: "AUDIO_QUEUE_FULL",
		message: "Audio queue is full; audio generation was skipped. The alert is still active.",
		error: key,
	});
};

const audioKeyForAlert = (
	alert: Pick<AlertData, "room" | "device_type" | "callType" | "placeType">
): string =>
	generateAudioFilename(alert.room, alert.device_type, alert.callType, alert.placeType);

const findActiveAlertByAudioKey = (key: string): ActiveAlert | undefined =>
	activeAlerts.find((alert) => audioKeyForAlert(alert) === key);

const enqueueAudioForAlert = (alert: AudioContext): void => {
	if (isEndCallType(alert.callType)) return;

	const key = audioKeyForAlert(alert);

	if (audioQueue.has(key)) return;

	const result = audioQueue.enqueue(key, async () => {
		// The alert may have been cancelled/reset while waiting in the queue.
		// Generate only while an alert with this audio key is still active.
		const activeAlert = findActiveAlertByAudioKey(key);

		if (!activeAlert) {
			console.log(`Skipping TTS; alert is no longer active: ${key}`);
			return;
		}

		// Check the file inside the bounded queue too, rather than starting an
		// unbounded number of filesystem probes when many events arrive at once.
		const ready = await audioFileIsReady(
			activeAlert.room,
			activeAlert.device_type,
			activeAlert.callType,
			activeAlert.placeType
		);

		if (ready) return;

		try {
			await generate(
				activeAlert.room,
				activeAlert.callType,
				activeAlert.device_type,
				activeAlert.placeType
			);

			// Do not announce audio for an alert that was cleared while TTS ran.
			const stillActive = findActiveAlertByAudioKey(key);

			if (stillActive) {
				io.emit("alert-audio-ready", stillActive);
			}
		} catch (error) {
			reportAudioFailure(error as Error, activeAlert);
		}
	});

	if (result === "full") {
		reportAudioDrop(key, alert);
	}
};

// Called once after history replay. Only the final active set is considered, so
// cancelled/acknowledged/reset calls from history never trigger TTS.
const recoverAudioForActiveAlerts = (): void => {
	const alerts = [...activeAlerts];

	for (const alert of alerts) {
		enqueueAudioForAlert(alert);
	}

	if (alerts.length > 0) {
		console.log(`Audio recovery scheduled for ${alerts.length} active alert(s)`);
	}
};

const processEvent = async (row: NcbEspRow): Promise<void> => {
	// Device retries can insert the same active call more than once with a
	// different sno. Ignore those exact duplicates so they cannot replay the
	// announcement. A repeated call with a new event time still gets through.
	if (!isEndCallType(row.callType) && isDuplicateActiveAlert(activeAlerts, row)) {
		console.log(
			`Ignoring duplicate active alert room=${row.room} device=${row.device_type} call=${row.callType} sno=${row.sno}`
		);
		// Do not re-announce, but still give a retry a chance to repair a
		// missing/invalid MP3. The queue coalesces this with any in-flight job,
		// and the task returns immediately when a valid file already exists.
		enqueueAudioForAlert(row);
		return;
	}

	// Critical path: apply the state transition and emit the alert before any
	// audio work. A cancel/acknowledged/reset is therefore never blocked behind
	// TTS, and the poller can continue reading the next event immediately.
	const alertData = applyEventToState(row);

	io.emit("new-alert", alertData);

	if (!isEndCallType(row.callType)) {
		enqueueAudioForAlert(alertData);
	}
};

// Rebuilds the in-memory alert list from the events already stored in MySQL.
// Historical events are applied only to state; they are not re-announced as
// new alerts. MAX(sno) and every replay batch run in one transaction so they
// share a consistent InnoDB snapshot (the production table is InnoDB with
// REPEATABLE-READ). If the engine were non-transactional, the cursor rule below
// still prevents a permanent skip.
const restoreStateFromHistory = async (): Promise<void> => {
	activeAlerts = [];

	const connection = await pool.getConnection();

	let highWaterMark = 0;
	let cursor = 0;

	try {
		await connection.beginTransaction();

		const [maxRows] = await connection.query("SELECT MAX(sno) AS maxSno FROM ncb_esp");
		const typedMaxRows = maxRows as { maxSno: number | null }[];

		highWaterMark = Number(typedMaxRows[0]?.maxSno ?? 0);

		while (cursor < highWaterMark) {
			const [rows] = await connection.query(
				"SELECT * FROM ncb_esp WHERE sno > ? AND sno <= ? ORDER BY sno ASC LIMIT ?",
				[cursor, highWaterMark, POLL_BATCH_SIZE]
			);

			const typedRows = rows as NcbEspRow[];

			if (typedRows.length === 0) break;

			for (const row of typedRows) {
				applyEventToState(row);
				cursor = row.sno;
			}

			if (typedRows.length < POLL_BATCH_SIZE) break;
		}

		// Under the InnoDB snapshot this should always be equal. If it is not, do
		// not mark state ready or advance the cursor; retry the whole replay from
		// a fresh snapshot instead of silently leaving a hole.
		if (cursor < highWaterMark) {
			throw new Error(
				`History replay stopped at sno ${cursor} before high-water mark ${highWaterMark}`
			);
		}

		await connection.commit();
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}

	// Only the last row actually applied becomes the cursor. This is equal to the
	// high-water mark after a complete replay, but assigning the cursor keeps the
	// invariant explicit: the cursor never moves without a processed row.
	lastProcessedSno = cursor;

	console.log(
		`Restored ${activeAlerts.length} active alert(s). lastSno: ${lastProcessedSno} (highWaterMark: ${highWaterMark})`
	);
};

// Reads pending events in ascending sno order. The cursor is advanced one row
// at a time, only after that row has been applied and emitted successfully.
// If the database fails mid-batch, the next cycle retries from the last fully
// processed event instead of jumping to the latest id.
const processPendingEvents = async (): Promise<void> => {
	while (true) {
		const [rows] = await pool.query(
			"SELECT * FROM ncb_esp WHERE sno > ? ORDER BY sno ASC LIMIT ?",
			[lastProcessedSno, POLL_BATCH_SIZE]
		);

		const typedRows = rows as NcbEspRow[];

		if (typedRows.length === 0) return;

		for (const row of typedRows) {
			await processEvent(row);
			lastProcessedSno = row.sno;
		}

		if (typedRows.length < POLL_BATCH_SIZE) return;

		// Let HTTP/socket work run between large batches.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
};

const checkNewEntry = (): void => {
	if (isChecking || !stateReady) return;

	isChecking = true;

	void runExclusive(processPendingEvents)
		.catch((error) => {
			const err = error as Error;

			console.error("Check Entry Error:", err.message);

			sendErrorToFrontend({
				type: "SERVER_ERROR",
				message: "Database connection  or Audio failed !",
				error: err.message,
			});
		})
		.finally(() => {
			isChecking = false;
		});
};

// Waits for the database, restores the active state, then starts exactly one
// polling interval. There is no "reset cursor to MAX" recovery path: while the
// database is unavailable the existing cursor stays where it was, and every
// event that arrived during the outage is processed in order afterwards.
const startPoller = async (): Promise<void> => {
	if (pollerStarted) return;

	pollerStarted = true;

	while (!stateReady) {
		if (shuttingDown) return;

		try {
			await restoreStateFromHistory();
			stateReady = true;
		} catch (error) {
			const err = error as Error;

			console.error("Initialization Error:", err.message);

			sendErrorToFrontend({
				type: "DB_CONNECTION_ERROR",
				message: "Database initialization failed. Retrying...",
				error: err.message,
			});

			await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	}

	if (shuttingDown) return;

	// Clients that connected before the replay finished receive the restored
	// state now. New clients get it directly from the connection handler.
	io.emit("existing-alerts", getSortedActiveAlerts());

	// Missing audio for the restored active set is generated in the background.
	// This is intentionally after the snapshot: a slow TTS provider must not
	// delay state delivery or poller startup.
	recoverAudioForActiveAlerts();

	pollerTimer = setInterval(checkNewEntry, POLL_INTERVAL_MS);

	// Drain anything inserted after the restore snapshot immediately.
	checkNewEntry();

	if (ttsConfig.kokoro.enabled && ttsConfig.kokoro.prewarm) {
		void warmKokoro().catch((error) => {
			console.error("Kokoro prewarm failed:", (error as Error).message);
		});
	}

	console.log("Polling started");
};

void startPoller();

app.post("/api/reset-alerts", async (_req, res) => {
	try {
		const resetCount = await runExclusive(async () => {
			const alertsToReset = [...activeAlerts];

			if (alertsToReset.length === 0) return 0;

			for (const alert of alertsToReset) {
				await pool.execute(
					`INSERT INTO ncb_esp
					 (room, floor, callType, device_type, card_number, location, tower, placeType, attended, date, time, emp_no, name, designation)
					 VALUES (?, ?, 'reset', ?, ?, ?, ?, ?, ?, CURDATE(), CURTIME(), ?, ?, ?)`,
					[
						alert.room,
						alert.floor,
						alert.device_type,
						alert.card_number,
						alert.location,
						alert.tower,
						alert.placeType,
						alert.attended,
						alert.emp_no,
						alert.name,
						alert.designation,
					]
				);
			}

			// The inserted reset rows stay in the event stream and are consumed
			// by the poller in sno order. The cursor is intentionally untouched.
			activeAlerts = [];

			io.emit("reset-alerts");

			return alertsToReset.length;
		});

		if (resetCount > 0) {
			console.log(`Reset ${resetCount} alert(s)`);
		}

		res.json({ success: true, resetCount });
	} catch (error) {
		const err = error as Error;
		console.error("Reset Alerts Error:", err.message);

		res.status(500).json({ success: false, message: "Failed to reset alerts" });
	}
});

io.on("connection", (socket) => {
	console.log("Client Connected:", socket.id);

	socket.emit("existing-alerts", getSortedActiveAlerts());

	socket.on("disconnect", () => {
		console.log("Client Disconnected:", socket.id);
	});
});

process.on("unhandledRejection", (err) => {
	console.error("Unhandled Rejection:", err);
});

const SHUTDOWN_TIMEOUT_MS = Math.max(
	1000,
	Number(process.env.SHUTDOWN_TIMEOUT_MS) || 15000
);

const closeCallbackPool = (): Promise<void> =>
	new Promise((resolve) => {
		try {
			callbackPool.end(() => resolve());
		} catch {
			resolve();
		}
	});

const closeHttpServer = (): Promise<void> =>
	new Promise((resolve) => {
		io.close(() => resolve());
	});

const shutdown = createGracefulShutdown({
	timeoutMs: SHUTDOWN_TIMEOUT_MS,
	steps: [
		{
			name: "alert poller",
			run: () => {
				shuttingDown = true;

				if (pollerTimer) clearInterval(pollerTimer);

				pollerTimer = undefined;
			},
		},
		{
			name: "in-flight alert operation",
			run: async () => {
				await operationQueue;
			},
		},
		{
			name: "audio queue",
			run: async () => {
				await audioQueue.waitForIdle();
			},
		},
		{ name: "HTTP and Socket.IO", run: closeHttpServer },
		{
			name: "database pools",
			run: async () => {
				await Promise.allSettled([pool.end(), closeCallbackPool()]);
			},
		},
	],
	onComplete: (exitCode) => {
		console.log(`[shutdown] Exiting with code ${exitCode}`);
		process.exit(exitCode);
	},
});

process.once("SIGINT", () => {
	void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
	void shutdown("SIGTERM");
});

process.once("uncaughtException", (err) => {
	console.error("Uncaught Exception:", err);
	void shutdown("uncaughtException", 1);
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});
