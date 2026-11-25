import { useCallback, useEffect, useRef, useState } from "react";
import { io,} from "socket.io-client";
import type { Socket } from "socket.io-client";
import { AlertContext } from "./AlertContext";
import { Alert, AlertContextValue, ConnectionStatus, ProcessedReport, ReportResponse, ServerError } from "../types";
import useDemoShortcut from "../hooks/useDemoShortcut";

const API_URL = import.meta.env.VITE_SERVER_APP_URL || "";
const SOCKET_PATH = import.meta.env.VITE_SOCKET_PATH || "/socket.io";

interface AlertProviderProps {
	children: React.ReactNode;
}

const AlertProvider = ({ children }: AlertProviderProps) => {
	const [isUnlocked, setIsUnlocked] = useState(false);
	const [alerts, setAlerts] = useState<Alert[]>([]);
	const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
	const [serverError, setServerError] = useState<ServerError | null>(null);
	const socketRef = useRef<Socket | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const sirenRef = useRef<HTMLAudioElement | null>(null);
	const isUnlockedRef = useRef<boolean>(false);
	const alertCounter = useRef<number>(0);
	const alertsRef = useRef<Alert[]>([]);
	const lastSnapshotKeyRef = useRef<string>("");
	const currentAudioKeyRef = useRef<string | null>(null);
	const audioFailedKeyRef = useRef<string | null>(null);

	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [reportData, setReportData] = useState<ProcessedReport[]>([]);
	const [formError, setFormError] = useState("");
	const [formLoading, setFormLoading] = useState(false);
	const [excelData, setExcelData] = useState<ReportResponse>({
		success: false,
		data: [],
		counts: {
			total_count: 0,
			calling_count: 0,
			emergency_count: 0,
			code_blue_count: 0,
			cancel_count: 0,
			acknowledged_count: 0,
			reset_count: 0,
			bed_count: 0,
			toilet_count: 0,
		},
	});

	// demo page Navigate
	  useDemoShortcut();
	
	const priorityMap: Record<string, number> = {
		"code blue": 1,
		emergency: 2,
		calling: 3,
	};

	const alertSourceKey = (alert: Alert): string =>
		`${alert.room}::${alert.device_type.toLowerCase()}`;

	const alertPlaybackKey = (alert: Alert): string =>
		`${alert.sno}::${alertSourceKey(alert)}::${(alert.callType || "").toLowerCase()}`;

	const enableAudio = (): void => {
		if (isUnlockedRef.current) return;

		isUnlockedRef.current = true;
		setIsUnlocked(true);

		const readyAudio = new Audio(`${import.meta.env.BASE_URL}System Ready.mp3`);

		readyAudio.onended = () => {
			const currentAlerts = alertsRef.current;

			if (currentAlerts.length > 0) {
				playAlertSound(currentAlerts[0]);
			}
		};

		readyAudio.play().catch(() => {});
	};

	useEffect(() => {
		const unlockAudio = () => {
			enableAudio();
		};

		window.addEventListener("click", unlockAudio, { once: true });

		return () => {
			window.removeEventListener("click", unlockAudio);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const stopCurrentAudio = (): void => {
		if (audioRef.current) {
			audioRef.current.onended = null;
			audioRef.current.onerror = null;
			audioRef.current.pause();
			audioRef.current.currentTime = 0;
		}

		if (sirenRef.current) {
			sirenRef.current.onended = null;
			sirenRef.current.pause();
			sirenRef.current.currentTime = 0;
		}

		currentAudioKeyRef.current = null;
		audioFailedKeyRef.current = null;
	};

	const resetAlerts = useCallback(async (): Promise<void> => {
		try {
			const res = await fetch(`${API_URL}/api/reset-alerts`, { method: "POST" });
			const data = await res.json();

			if (data.success) {
				stopCurrentAudio();
				setAlerts([]);
				alertsRef.current = [];
				lastSnapshotKeyRef.current = "";
				audioFailedKeyRef.current = null;
			}
		} catch (err) {
			console.error("Reset alerts failed:", err);
		}
	}, []);

	const playAlertSound = (alert: Alert): void => {
		if (!isUnlockedRef.current || !alert) return;

		const url = `${API_URL}${alert.audio}`;
		const playbackKey = alertPlaybackKey(alert);

		stopCurrentAudio();
		currentAudioKeyRef.current = playbackKey;

		const markAudioFailure = (): void => {
			if (currentAudioKeyRef.current === playbackKey) {
				audioFailedKeyRef.current = playbackKey;
			}
		};

		const playVoice = () => {
			if (!audioRef.current) {
				audioRef.current = new Audio();
			}

			const audio = audioRef.current;

			audio.onended = null;
			audio.onerror = null;
			audio.src = url;
			audio.currentTime = 0;
			audio.onended = () => {
				if (!alertsRef.current.length) return;

				const nextAlert = alertsRef.current[0];

				if (nextAlert.callType?.toLowerCase() === "emergency") {
					playSiren();
					return;
				}

				playAlertSound(nextAlert);
			};
			// A restored alert's MP3 may still be generating in the background.
			// Record the failure; `alert-audio-ready` will retry this same alert.
			audio.onerror = markAudioFailure;
			audio
				.play()
				.then(() => {
					if (audioFailedKeyRef.current === playbackKey) {
						audioFailedKeyRef.current = null;
					}
				})
				.catch(markAudioFailure);
		};

		const playSiren = () => {
			if (!sirenRef.current) {
				sirenRef.current = new Audio(`${import.meta.env.BASE_URL}sirensound.mp3`);
			}

			const siren = sirenRef.current;

			siren.onended = null;
			siren.currentTime = 0;

			siren.onended = () => {
				if (!alertsRef.current.length) return;
				playVoice();
			};

			siren.play().catch(() => {});
		};

		playVoice();
	};

	const handleNewAlert = (data: Alert): void => {
		const callType = data.callType?.toLowerCase();

		if (callType === "cancel" || callType === "acknowledged" || callType === "reset") {
			setAlerts((prev) => {
				const updated = prev.filter(
					(a) =>
						!(
							a.room === data.room &&
							a.device_type.toLowerCase() === data.device_type.toLowerCase()
						)
				);

				alertsRef.current = updated;

				if (updated.length > 0) {
					playAlertSound(updated[0]);
				} else {
					stopCurrentAudio();
				}

				return updated;
			});

			return;
		}

		data.order = alertCounter.current++;
		const newPriority = priorityMap[data.callType?.toLowerCase()] || 99;

		const currentAlert = alertsRef.current[0];

		const currentPriority = priorityMap[currentAlert?.callType?.toLowerCase()] || 99;

		if (newPriority < currentPriority) {
			stopCurrentAudio();
		}

		setAlerts((prev) => {
			const filtered = prev.filter(
				(a) => !(a.room === data.room && a.device_type.toLowerCase() === data.device_type.toLowerCase())
			);

			const updated = [...filtered, data];

			updated.sort((a, b) => {
				const pa = priorityMap[a.callType?.toLowerCase()] || 99;
				const pb = priorityMap[b.callType?.toLowerCase()] || 99;

				if (pa !== pb) return pa - pb;

				if (a.room === b.room) {
					return (b.order ?? 0) - (a.order ?? 0);
				}

				return b.sno - a.sno;
			});
			alertsRef.current = updated;

			if (newPriority <= currentPriority || alertsRef.current.length === 1) {
				playAlertSound(data);
			}
			return updated;
		});
	};

	const handleAudioReady = (data: Alert): void => {
		if (!isUnlockedRef.current || !data) return;

		const head = alertsRef.current[0];

		if (!head) return;

		const headKey = alertPlaybackKey(head);

		// Only the alert at the head of the audio queue matters. If it finishes
		// generating later, retry it; do not interrupt audio that is already playing.
		if (headKey !== alertPlaybackKey(data)) return;

		const audio = audioRef.current;
		const isPlaying = Boolean(audio && !audio.paused && !audio.ended);

		if (isPlaying && audioFailedKeyRef.current !== headKey) return;

		audioFailedKeyRef.current = null;
		playAlertSound(head);
	};

	useEffect(() => {
		socketRef.current = io(window.location.origin, {
		path: SOCKET_PATH,
		transports: ["polling", "websocket"],
	});

		const socket = socketRef.current;

		socket.on("new-alert", handleNewAlert);
		socket.on("alert-audio-ready", handleAudioReady);

		socket.on("existing-alerts", (data: Alert[]) => {
			if (!Array.isArray(data)) return;

			const maxSnapshotSno = data.reduce(
				(max, alert) => Math.max(max, Number(alert.sno) || 0),
				0
			);
			const mergedBySource = new Map<string, Alert>();

			for (const alert of data) {
				mergedBySource.set(alertSourceKey(alert), alert);
			}

			// Socket.IO preserves event order, but preserve a genuinely newer live
			// alert if it is already in memory when a non-empty snapshot arrives.
			// An empty snapshot is authoritative and clears stale client state.
			let preservedNewer = false;

			if (data.length > 0) {
				for (const alert of alertsRef.current) {
					if (Number(alert.sno) <= maxSnapshotSno) continue;

					const source = alertSourceKey(alert);
					const snapshotAlert = mergedBySource.get(source);

					if (!snapshotAlert || Number(alert.sno) > Number(snapshotAlert.sno)) {
						mergedBySource.set(source, alert);
						preservedNewer = true;
					}
				}
			}

			const sorted = [...mergedBySource.values()].map((alert) => ({
				...alert,
				order: alertCounter.current++,
			}));

			sorted.sort((a, b) => {
				const pa = priorityMap[a.callType?.toLowerCase()] || 99;
				const pb = priorityMap[b.callType?.toLowerCase()] || 99;

				if (pa !== pb) return pa - pb;

				return b.sno - a.sno;
			});

			alertsRef.current = sorted;
			setAlerts(sorted);

			const snapshotKey = sorted.map(alertPlaybackKey).join("|");
			const snapshotChanged = snapshotKey !== lastSnapshotKeyRef.current;

			lastSnapshotKeyRef.current = snapshotKey;

			if (sorted.length === 0) {
				audioFailedKeyRef.current = null;
				stopCurrentAudio();
				return;
			}

			if (!isUnlockedRef.current) return;

			const headKey = alertPlaybackKey(sorted[0]);
			const audio = audioRef.current;
			const audioPlaying = Boolean(audio && !audio.paused && !audio.ended);

			// A newer live event is already in memory and may already be playing.
			// Do not let an older snapshot interrupt it.
			if (preservedNewer && audioPlaying) return;

			// Do not restart audio for a repeated snapshot or for the alert that is
			// already playing. This also prevents duplicate playback on reconnect.
			if (snapshotChanged && currentAudioKeyRef.current !== headKey) {
				playAlertSound(sorted[0]);
			} else {
				const audio = audioRef.current;
				const hadFailure = audioFailedKeyRef.current === headKey;
				const hasError = Boolean(audio && audio.error);

				// If playback previously failed for this alert (e.g. during a
				// backend outage) or the audio element is in an error state,
				// retry playback instead of assuming the alert is still playing.
				// `!audio.paused && !audio.ended` alone is not reliable: a
				// rejected play() does not change the paused attribute.
				if (hadFailure || hasError) {
					playAlertSound(sorted[0]);
				}
			}
		});

		socket.on("connect", () => {
			setConnectionStatus("connected");
			setServerError(null);
		});

		socket.on("disconnect", () => {
			setConnectionStatus("disconnected");
		});

		socket.on("connect_error", () => {
			setConnectionStatus("disconnected");
		});

		socket.on("server-error", (data: { message: ServerError["message"]; time: string }) => {
			setServerError({
				message: data.message,
				time: new Date(data.time),
			});

			setTimeout(() => setServerError(null), 6000);
		});

		socket.on("reset-alerts", () => {
			stopCurrentAudio();
			setAlerts([]);
			alertsRef.current = [];
			lastSnapshotKeyRef.current = "";
			audioFailedKeyRef.current = null;
		});

		return () => {
			socket.off("new-alert", handleNewAlert);
			socket.off("alert-audio-ready", handleAudioReady);
			socket.off("existing-alerts");
			socket.off("reset-alerts");
			socket.off("connect");
			socket.off("disconnect");
			socket.off("connect_error");
			socket.off("server-error");
			socket.disconnect();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const contextValue: AlertContextValue = {
		alerts,
		setAlerts,
		isUnlocked,
		setIsUnlocked,
		connectionStatus,
		setConnectionStatus,
		serverError,
		setServerError,
		socketRef: socketRef as React.RefObject<Socket>,
		audioRef,
		sirenRef,
		isUnlockedRef,
		alertCounter,
		alertsRef,
		enableAudio,
		resetAlerts,
		from,
		setFrom,
		to,
		setTo,
		reportData,
		setReportData,
		formError,
		setFormError,
		formLoading,
		setFormLoading,
		excelData,
		setExcelData,
	};

	return (
		<AlertContext.Provider value={contextValue}>
			{children}
		</AlertContext.Provider>
	);
};

export default AlertProvider;
