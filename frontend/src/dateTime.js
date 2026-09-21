import { boot } from "./api";

const FALLBACK_TIMEZONE = "UTC";

export function resolveTimeZones(source = boot) {
  const systemTimezone = source?.system_timezone || FALLBACK_TIMEZONE;
  return {
    systemTimezone,
    userTimezone: source?.effective_user_timezone || source?.user_timezone || systemTimezone,
  };
}

function dateParts(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}

function dateTimeParts(value) {
  const match = String(value || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/
  );
  return match
    ? {
        year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
        hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] || 0),
      }
    : null;
}

function partsInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
}

export function frappeDateTimeToInstant(value, siteTimezone = resolveTimeZones().systemTimezone) {
  const desired = dateTimeParts(value);
  if (!desired) return null;
  const desiredUtc = Date.UTC(
    desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, desired.second
  );
  let instant = desiredUtc;
  // Interpret the naive Frappe value in siteTimezone, independent of the
  // browser's local timezone. The correction converges across DST changes.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = partsInTimezone(new Date(instant), siteTimezone);
    const actualUtc = Date.UTC(
      actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second
    );
    const correction = desiredUtc - actualUtc;
    instant += correction;
    if (!correction) break;
  }
  return new Date(instant);
}

export function formatDateTime(
  value,
  targetTimezone = resolveTimeZones().userTimezone,
  siteTimezone = resolveTimeZones().systemTimezone
) {
  if (!value) return "—";
  const instant = frappeDateTimeToInstant(value, siteTimezone);
  if (!instant) return String(value);
  const parts = partsInTimezone(instant, targetTimezone);
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(parts.day)}.${pad(parts.month)}.${parts.year} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatDateOnly(value) {
  if (!value) return "—";
  const parts = dateParts(value);
  if (!parts) return String(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(parts.day)}.${pad(parts.month)}.${parts.year}`;
}

export function dateInTimezone(timeZone = resolveTimeZones().userTimezone, now = new Date()) {
  const parts = partsInTimezone(now, timeZone);
  const pad = (number) => String(number).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function monthInTimezone(timeZone = resolveTimeZones().userTimezone, now = new Date()) {
  return dateInTimezone(timeZone, now).slice(0, 7);
}

export function monthStartInTimezone(timeZone = resolveTimeZones().userTimezone, now = new Date()) {
  return `${monthInTimezone(timeZone, now)}-01`;
}

export function toDateTimeLocal(value) {
  const parts = dateTimeParts(value);
  if (!parts) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function fromDateTimeLocal(value) {
  const parts = dateTimeParts(value);
  if (!parts) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}
