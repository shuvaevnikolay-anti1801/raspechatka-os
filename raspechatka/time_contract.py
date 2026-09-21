"""Shared, explicit time semantics for Frappe and Web OS.

Frappe Datetime values are naive wall-clock values in the site timezone.  Values
crossing an external boundary are offset-aware RFC3339 instants.  Date values
remain calendar dates and are never passed through instant conversion.
"""

from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


_RFC3339_INSTANT: Final = re.compile(
    r"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?"
    r"(?:Z|[+-]\\d{2}:\\d{2})$"
)


class TimeContractError(ValueError):
    """Raised when a value does not satisfy the canonical time contract."""


def validate_timezone(value: str) -> str:
    """Return *value* when it is a valid, non-empty IANA timezone name."""
    if not isinstance(value, str) or not value.strip():
        raise TimeContractError("timezone must be a non-empty IANA name")
    name = value.strip()
    try:
        ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise TimeContractError(f"invalid IANA timezone: {name}") from exc
    return name


def configured_site_timezone(value: str | None) -> str | None:
    """Validate an explicitly configured site timezone, preserving empty as unset."""
    if value is None or not str(value).strip():
        return None
    return validate_timezone(str(value))


def effective_site_timezone(frappe_timezone: str) -> str:
    """Validate the timezone selected by Frappe; this function adds no fallback."""
    return validate_timezone(frappe_timezone)


def get_configured_site_timezone() -> str | None:
    """Read and validate System Settings.time_zone without inventing a fallback."""
    import frappe

    return configured_site_timezone(
        frappe.db.get_single_value("System Settings", "time_zone")
    )


def get_effective_site_timezone() -> str:
    """Use Frappe's own effective system timezone as the runtime source of truth."""
    from frappe.utils import get_system_timezone

    return effective_site_timezone(get_system_timezone())


def resolve_point_timezone(
    point_timezone_value: str | None, site_timezone: str
) -> str:
    """Resolve a point timezone, falling back explicitly to the site timezone."""
    site = validate_timezone(site_timezone)
    configured = configured_site_timezone(point_timezone_value)
    return configured or site


def parse_external_instant(value: str | datetime) -> datetime:
    """Parse an offset-aware RFC3339 instant; offset-less values are rejected."""
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise TimeContractError("external instant must include an explicit offset")
        return value

    if not isinstance(value, str) or not _RFC3339_INSTANT.fullmatch(value.strip()):
        raise TimeContractError(
            "external instant must be RFC3339 with an explicit offset"
        )
    text = value.strip()
    if text.endswith("-00:00"):
        raise TimeContractError("unknown RFC3339 offset is ambiguous")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise TimeContractError("invalid RFC3339 instant") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise TimeContractError("external instant must include an explicit offset")
    return parsed


def _site_zone(site_timezone: str) -> ZoneInfo:
    return ZoneInfo(validate_timezone(site_timezone))


def _require_site_naive_datetime(value: datetime) -> datetime:
    if isinstance(value, date) and not isinstance(value, datetime):
        raise TypeError("Date values are not Datetime instants")
    if not isinstance(value, datetime):
        raise TypeError("expected a datetime")
    if value.tzinfo is not None:
        raise TimeContractError("Frappe datetime must be timezone-naive")
    return value


def external_instant_to_site_naive(
    value: str | datetime, site_timezone: str
) -> datetime:
    """Convert an external instant to a naive Frappe site-local datetime."""
    instant = parse_external_instant(value)
    return instant.astimezone(_site_zone(site_timezone)).replace(tzinfo=None)


def site_naive_to_utc_rfc3339(value: datetime, site_timezone: str) -> str:
    """Serialize a naive Frappe site-local datetime as a UTC RFC3339 instant."""
    naive = _require_site_naive_datetime(value)
    utc_value = naive.replace(tzinfo=_site_zone(site_timezone)).astimezone(timezone.utc)
    return utc_value.isoformat().replace("+00:00", "Z")


def site_naive_to_target_datetime(
    value: datetime, target_timezone: str, site_timezone: str
) -> datetime:
    """Interpret a Frappe value in site time and return an aware target value."""
    naive = _require_site_naive_datetime(value)
    return naive.replace(tzinfo=_site_zone(site_timezone)).astimezone(
        _site_zone(target_timezone)
    )


def site_naive_to_target_date(
    value: datetime, target_timezone: str, site_timezone: str
) -> date:
    """Convert a Frappe Datetime to a target-local calendar date."""
    return site_naive_to_target_datetime(value, target_timezone, site_timezone).date()


def point_local_date_bounds_to_site_naive(
    local_date: date, point_timezone: str, site_timezone: str
) -> tuple[datetime, datetime]:
    """Return [start, end) of a point-local Date as naive site datetimes."""
    if isinstance(local_date, datetime) or not isinstance(local_date, date):
        raise TypeError("point-local bounds require a Date, not a Datetime")
    point_zone = _site_zone(point_timezone)
    site_zone = _site_zone(site_timezone)
    next_date = local_date + timedelta(days=1)
    start = datetime.combine(local_date, time.min, tzinfo=point_zone)
    end = datetime.combine(next_date, time.min, tzinfo=point_zone)
    return (
        start.astimezone(site_zone).replace(tzinfo=None),
        end.astimezone(site_zone).replace(tzinfo=None),
    )


def ensure_site_timezone_after_install() -> None:
    """Set UTC only for a brand-new install whose setting is still empty."""
    import frappe

    current = frappe.db.get_single_value("System Settings", "time_zone")
    if current is None or not str(current).strip():
        frappe.db.set_single_value("System Settings", "time_zone", "UTC")
