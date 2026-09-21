import assert from "node:assert/strict";
import test from "node:test";
import {
	dateInTimezone,
	formatDateOnly,
	formatDateTime,
	monthInTimezone,
	resolveTimeZones,
	toDateTimeLocal,
	fromDateTimeLocal,
} from "../src/dateTime.js";

test("formats one Frappe datetime in the requested user timezone", () => {
	const raw = "2026-01-15 23:30:45";
	assert.equal(formatDateTime(raw, "America/New_York", "Europe/Moscow"), "15.01.2026 15:30");
	assert.equal(formatDateTime(raw, "Asia/Tokyo", "Europe/Moscow"), "16.01.2026 05:30");
	assert.match(formatDateTime(raw, "Europe/Moscow", "UTC"), /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
});

test("date-only values never pass through UTC", () => {
	assert.equal(formatDateOnly("2026-01-15"), "15.01.2026");
});

test("today and month use the explicit target timezone near UTC midnight", () => {
	const instant = new Date("2026-01-31T23:30:00.000Z");
	assert.equal(dateInTimezone("Asia/Tokyo", instant), "2026-02-01");
	assert.equal(monthInTimezone("Asia/Tokyo", instant), "2026-02");
	assert.equal(dateInTimezone("America/New_York", instant), "2026-01-31");
});

test("user timezone falls back to system timezone", () => {
	assert.deepEqual(resolveTimeZones({ system_timezone: "Europe/Moscow" }), {
		systemTimezone: "Europe/Moscow",
		userTimezone: "Europe/Moscow",
	});
	assert.equal(
		resolveTimeZones({
			system_timezone: "Europe/Moscow",
			effective_user_timezone: "Asia/Tokyo",
		}).userTimezone,
		"Asia/Tokyo"
	);
});

test("datetime-local round trips as domain-local text", () => {
	const raw = "2026-01-15 23:30:45";
	assert.equal(toDateTimeLocal(raw), "2026-01-15T23:30");
	assert.equal(fromDateTimeLocal("2026-01-15T23:30"), "2026-01-15 23:30:00");
});
