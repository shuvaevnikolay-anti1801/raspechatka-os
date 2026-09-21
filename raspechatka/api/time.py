"""Web OS timezone diagnostics for administrators."""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, available_timezones

import frappe
from frappe import _

from raspechatka.access import get_scope, require_access
from raspechatka.access_contract import access_contract
from raspechatka.time_contract import (
    TimeContractError,
    get_effective_site_timezone,
    validate_timezone,
)


def _require_admin():
    require_access("page.references.users", "admin")


def _warning(code, message, subject=None):
    item = {"code": code, "message": message}
    if subject:
        item["subject"] = subject
    return item


def _configured_site_timezone(warnings):
    raw = frappe.db.get_single_value("System Settings", "time_zone")
    if raw in (None, ""):
        return None
    try:
        return validate_timezone(str(raw))
    except TimeContractError:
        warnings.append(
            _warning(
                "invalid_site_timezone",
                _("В System Settings указана недопустимая IANA-зона: {0}").format(raw),
            )
        )
        return None


def _effective_site_timezone(warnings):
    try:
        return get_effective_site_timezone()
    except TimeContractError as exc:
        warnings.append(_warning("invalid_effective_site_timezone", str(exc)))
        return None


def _local_iso(moment, timezone_name):
    if not timezone_name:
        return None
    return moment.astimezone(ZoneInfo(timezone_name)).isoformat()


def _point_filters():
    scope = get_scope()
    filters = {"active": 1}
    if not scope["global"]:
        filters["name"] = ["in", scope["points"] or ["__none__"]]
    return filters


@frappe.whitelist()
@access_contract(area="page.references.users", action="admin", scope="user")
def get_time_diagnostics():
    """Return only the current admin's user settings and accessible point zones."""
    _require_admin()
    warnings = []
    configured_site = _configured_site_timezone(warnings)
    effective_site = _effective_site_timezone(warnings)

    if not configured_site:
        warnings.append(
            _warning(
                "missing_site_timezone",
                _("Системный часовой пояс не задан явно; проверьте canonical site-time настройку."),
            )
        )
    if effective_site == "Asia/Kolkata" and not configured_site:
        warnings.append(
            _warning(
                "legacy_frappe_fallback",
                _("Frappe использует исторический fallback Asia/Kolkata."),
            )
        )

    user = frappe.get_cached_doc("User", frappe.session.user)
    raw_user_timezone = user.time_zone or None
    configured_user = raw_user_timezone
    valid_user_timezone = None
    if raw_user_timezone:
        try:
            valid_user_timezone = validate_timezone(raw_user_timezone)
        except TimeContractError:
            warnings.append(
                _warning(
                    "invalid_user_timezone",
                    _("У текущего пользователя указана недопустимая IANA-зона: {0}").format(
                        raw_user_timezone
                    ),
                    frappe.session.user,
                )
            )
    effective_user = valid_user_timezone or effective_site
    if not valid_user_timezone:
        warnings.append(
            _warning(
                "user_timezone_fallback",
                _("Для текущего пользователя используется системный часовой пояс."),
                frappe.session.user,
            )
        )

    now_utc = datetime.now(timezone.utc)
    points = []
    for point in frappe.get_all(
        "Business Point",
        filters=_point_filters(),
        fields=["name", "point_name", "timezone"],
        order_by="point_name asc",
        limit_page_length=10000,
    ):
        raw_timezone = point.timezone or None
        point_timezone = effective_site
        if raw_timezone:
            try:
                point_timezone = validate_timezone(raw_timezone)
            except TimeContractError:
                warnings.append(
                    _warning(
                        "invalid_point_timezone",
                        _("У точки указана недопустимая IANA-зона: {0}").format(raw_timezone),
                        point.name,
                    )
                )
        else:
            warnings.append(
                _warning(
                    "missing_point_timezone",
                    _("У точки не задан часовой пояс; используется системный."),
                    point.name,
                )
            )
        points.append(
            {
                "name": point.name,
                "label": point.point_name or point.name,
                "timezone": point_timezone,
                "configured_timezone": raw_timezone,
            }
        )

    return {
        "configured_site_timezone": configured_site,
        "effective_site_timezone": effective_site,
        "current_user": {
            "name": user.name,
            "configured_timezone": configured_user,
            "effective_timezone": effective_user,
        },
        "now": {
            "utc": now_utc.isoformat().replace("+00:00", "Z"),
            "site": _local_iso(now_utc, effective_site),
            "user": _local_iso(now_utc, effective_user),
        },
        "points": points,
        "warnings": warnings,
    }


def get_timezone_options():
    """Return the validated IANA names used by the Users selector."""
    return sorted(available_timezones())
