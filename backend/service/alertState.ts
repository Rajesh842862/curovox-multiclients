import { ActiveAlert, AlertData, NcbEspRow } from "../types";
import { generateAudioFilename } from "./ttsService";

const END_CALL_TYPES = new Set(["cancel", "acknowledged", "reset"]);

const PRIORITY: Record<string, number> = {
	"code blue": 1,
	emergency: 2,
	calling: 3,
};

export function isEndCallType(callType: string | undefined | null): boolean {
	return END_CALL_TYPES.has((callType || "").toLowerCase());
}

export function isSameAlertSource(
	alert: Pick<ActiveAlert, "room" | "device_type">,
	row: Pick<NcbEspRow, "room" | "device_type">
): boolean {
	return (
		alert.room === row.room &&
		alert.device_type.toLowerCase() === row.device_type.toLowerCase()
	);
}

export function toAlertData(row: NcbEspRow): AlertData {
	return {
		...row,
		audio: `/audio/${generateAudioFilename(
			row.room,
			row.device_type,
			row.callType,
			row.placeType
		)}`,
	};
}

// A device can retry the same call and produce a second row with the same
// business payload but a different sno/time_of_DB. Treating that as a new alert
// would replay the announcement, so compare the event payload instead.
export function isDuplicateActiveAlert(
	activeAlerts: ActiveAlert[],
	row: NcbEspRow
): boolean {
	return activeAlerts.some(
		(alert) =>
			isSameAlertSource(alert, row) &&
			alert.callType.toLowerCase() === row.callType.toLowerCase() &&
			alert.floor === row.floor &&
			alert.card_number === row.card_number &&
			alert.location === row.location &&
			alert.tower === row.tower &&
			alert.placeType === row.placeType &&
			alert.attended === row.attended &&
			alert.date === row.date &&
			alert.time === row.time &&
			alert.emp_no === row.emp_no &&
			alert.name === row.name &&
			alert.designation === row.designation
	);
}

// New calls replace any existing alert for the same room/device. Cancel,
// acknowledged and reset events remove it. This is idempotent so a retried or
// duplicated event converges to the same state.
export function applyAlertEvent(
	activeAlerts: ActiveAlert[],
	row: NcbEspRow
): { alerts: ActiveAlert[]; alertData: AlertData } {
	const alertData = toAlertData(row);
	const alerts = activeAlerts.filter(
		(alert) => !isSameAlertSource(alert, row)
	);

	if (!isEndCallType(row.callType)) alerts.unshift(alertData);

	return { alerts, alertData };
}

export function sortActiveAlerts(activeAlerts: ActiveAlert[]): ActiveAlert[] {
	return [...activeAlerts].sort((a, b) => {
		const pa = PRIORITY[a.callType?.toLowerCase()] || 99;
		const pb = PRIORITY[b.callType?.toLowerCase()] || 99;

		if (pa !== pb) return pa - pb;

		if (a.room !== b.room) {
			return a.room.localeCompare(b.room);
		}

		return b.sno - a.sno;
	});
}
