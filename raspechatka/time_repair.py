"""Auditable, conservative historical time repair for DEV-161.

The service is deliberately registry-driven.  It never scans arbitrary Datetime
columns and never submits, cancels, or replays business documents.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import frappe
from frappe.utils import get_datetime, get_system_timezone

from raspechatka.time_contract import (
    TimeContractError,
    external_instant_to_site_naive,
    resolve_point_timezone,
    site_naive_to_target_date,
    validate_timezone,
)


REPAIR_CONTRACT_VERSION = "DEV-161-TIME-REPAIR-v1"
REPORT_FILE_NAME = f"{REPAIR_CONTRACT_VERSION}.json"
BATCH_SIZE = 200
CLIENT_REGISTERED_TOLERANCE = timedelta(minutes=5)

# Only these proven event paths are eligible.  Adding a field requires a
# documented provenance rule and a focused fixture.
POS_UTC_REGISTRY = (
    ("Sales Shift", "opened_at", "source", "POS", "openedAt"),
    ("Sales Shift", "closed_at", "source", "POS", "closedAt"),
    ("Sales Receipt", "posting_datetime", "source", "POS", "postingDatetime"),
    ("Cash Movement", "posting_datetime", "source", "POS", "postingDatetime"),
    ("POS Order", "created_at", "source_pos_event", "set", "createdAt"),
    ("POS Order", "due_at", "source_pos_event", "set", "dueAt"),
    ("POS Order", "ready_at", "source_pos_event", "set", "readyAt"),
    ("POS Order", "issued_at", "source_pos_event", "set", "issuedAt"),
    ("POS Cash Count", "counted_at", "source_pos_event", "set", "countedAt"),
)

# These POS stock documents receive posting_datetime from server now_datetime(),
# so they belong to the old-site-wall-clock class, not the POS UTC class.
POS_SITE_REGISTRY = (
    ("Stock Write Off", "posting_datetime", "source", "POS"),
    ("Stock Receipt", "posting_datetime", "source", "POS"),
)

# This is intentionally explicit rather than a repository-wide Datetime loop.
APP_OWNED_CREATION_MODIFIED_DOCTYPES = (
    "Business Point",
    "Business Entity",
    "Employee",
    "Catalog Item",
    "Catalog Group",
    "Organization",
    "Raspechatka User Profile",
    "POS Workplace",
    "POS Connection",
    "Sales Shift",
    "Sales Receipt",
    "Cash Movement",
    "Cashier Action",
    "POS Order",
    "POS Cash Count",
    "Client",
    "Stock Write Off",
    "Stock Receipt",
)

BUSINESS_DATE_REGISTRY = (
    ("Sales Shift", "opened_at"),
    ("Sales Receipt", "posting_datetime"),
    ("Cash Movement", "posting_datetime"),
    ("Cashier Action", "action_datetime"),
)

# No modified cursor was found in the targeted raspechatka/** audit.  Keep this
# registry explicit so a future cursor cannot silently be missed by migration.
MODIFIED_CURSOR_REGISTRY: tuple[tuple[str, str], ...] = ()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _as_datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    parsed = get_datetime(value)
    if parsed is None:
        return None
    if parsed.tzinfo is not None:
        raise TimeContractError("historical Frappe Datetime must be naive")
    return parsed


def _iso(value: Any) -> str | None:
    parsed = _as_datetime(value)
    return parsed.isoformat(sep=" ") if parsed else None


def _same_datetime(left: Any, right: Any) -> bool:
    return _as_datetime(left) == _as_datetime(right)


def _ambiguous_local(value: datetime, timezone_name: str) -> bool:
    """Reject ambiguous/non-existent source wall clocks instead of guessing."""
    zone = ZoneInfo(validate_timezone(timezone_name))
    first = value.replace(tzinfo=zone, fold=0)
    second = value.replace(tzinfo=zone, fold=1)
    if first.utcoffset() == second.utcoffset():
        return False
    first_back = first.astimezone(UTC).astimezone(zone).replace(tzinfo=None)
    second_back = second.astimezone(UTC).astimezone(zone).replace(tzinfo=None)
    return first_back != value or second_back != value or first_back == second_back


def _site_wall_clock(value: Any, source_timezone: str, target_timezone: str) -> datetime:
    naive = _as_datetime(value)
    if naive is None:
        raise TimeContractError("empty historical Datetime")
    if _ambiguous_local(naive, source_timezone):
        raise TimeContractError(
            f"ambiguous or non-existent local time in {source_timezone}: {naive}"
        )
    return naive.replace(tzinfo=ZoneInfo(source_timezone)).astimezone(
        ZoneInfo(target_timezone)
    ).replace(tzinfo=None)


def _pos_utc_wall_clock(value: Any, target_timezone: str) -> datetime:
    naive = _as_datetime(value)
    if naive is None:
        raise TimeContractError("empty historical Datetime")
    return naive.replace(tzinfo=timezone.utc).astimezone(ZoneInfo(target_timezone)).replace(tzinfo=None)


def _version_history() -> tuple[list[dict[str, Any]], list[str]]:
    rows = frappe.get_all(
        "Version",
        filters={"ref_doctype": "System Settings", "docname": "System Settings"},
        fields=["name", "creation", "data"],
        order_by="creation asc, name asc",
        limit_page_length=100000,
    )
    changes = []
    errors = []
    for row in rows:
        try:
            payload = row.data if isinstance(row.data, dict) else json.loads(row.data or "{}")
        except (TypeError, ValueError) as exc:
            errors.append(f"Version {row.name}: invalid JSON ({exc})")
            continue
        for change in payload.get("changed") or []:
            if not isinstance(change, (list, tuple)) or len(change) < 3 or change[0] != "time_zone":
                continue
            old_value = change[1] or None
            new_value = change[2] or None
            for label, value in (("old", old_value), ("new", new_value)):
                if value:
                    try:
                        validate_timezone(str(value))
                    except TimeContractError:
                        errors.append(f"Version {row.name}: invalid {label} timezone {value}")
            changes.append(
                {
                    "version": row.name,
                    "at": _as_datetime(row.creation),
                    "old": old_value,
                    "new": new_value,
                }
            )
    return changes, errors


def _point_evidence() -> tuple[list[dict[str, Any]], list[str]]:
    rows = frappe.get_all(
        "Business Point",
        filters={"active": 1},
        fields=["name", "timezone"],
        order_by="name asc",
        limit_page_length=100000,
    )
    evidence = []
    errors = []
    for row in rows:
        if not row.timezone:
            errors.append(f"active point {row.name}: missing timezone")
            continue
        try:
            evidence.append({"name": row.name, "timezone": validate_timezone(row.timezone)})
        except TimeContractError:
            errors.append(f"active point {row.name}: invalid timezone {row.timezone}")
    return evidence, errors


def _site_evidence() -> dict[str, Any]:
    raw = frappe.db.get_single_value("System Settings", "time_zone") or None
    configured = None
    configured_error = None
    if raw:
        try:
            configured = validate_timezone(str(raw))
        except TimeContractError as exc:
            configured_error = str(exc)

    points, point_errors = _point_evidence()
    unique_points = sorted({row["timezone"] for row in points})
    history, history_errors = _version_history()
    core_blockers = list(history_errors)
    if configured_error:
        core_blockers.append(f"invalid configured site timezone: {configured_error}")

    if configured and configured != "Asia/Kolkata":
        target = configured
    elif (
        configured == "Asia/Kolkata"
        and not point_errors
        and len(unique_points) == 1
        and unique_points[0] != configured
    ):
        target = unique_points[0]
    elif not configured and not point_errors and len(unique_points) == 1:
        target = unique_points[0]
    else:
        target = "UTC" if not configured else configured

    if point_errors and not configured:
        # Invalid/missing points make point-based target selection non-provable.
        target = "UTC"
    if not configured and not history:
        source_default = "Asia/Kolkata"
    else:
        source_default = configured or "Asia/Kolkata"

    epochs = []
    if history and not history_errors:
        expected = None
        for change in history:
            old_value = change["old"] or source_default
            new_value = change["new"] or source_default
            try:
                old_zone = validate_timezone(str(old_value))
                new_zone = validate_timezone(str(new_value))
            except TimeContractError:
                continue
            if expected is None:
                epochs.append(
                    {
                        "start": None,
                        "source_timezone": old_zone,
                        "version": f"{change['version']}:before",
                    }
                )
            elif old_zone != expected:
                core_blockers.append(
                    f"contradictory System Settings.time_zone history at {change['version']}"
                )
            if new_zone != old_zone:
                epochs.append(
                    {
                        "start": change["at"],
                        "source_timezone": new_zone,
                        "version": change["version"],
                    }
                )
            expected = new_zone
        if expected and configured and expected != configured:
            core_blockers.append("System Settings current timezone disagrees with Version history")
        # Collapse duplicate consecutive values while preserving evidence.
        collapsed = []
        for epoch in epochs:
            if collapsed and collapsed[-1]["source_timezone"] == epoch["source_timezone"]:
                continue
            collapsed.append(epoch)
        epochs = collapsed
    if not epochs:
        epochs = [{"start": None, "source_timezone": source_default, "version": "fallback/config"}]

    for index, epoch in enumerate(epochs):
        epoch["end"] = epochs[index + 1]["start"] if index + 1 < len(epochs) else None

    return {
        "configured_raw": raw,
        "configured_timezone": configured,
        "effective_before": None,
        "target_timezone": target,
        "source_default_timezone": source_default,
        "epochs": [
            {
                "start": _iso(epoch["start"]),
                "end": _iso(epoch["end"]),
                "source_timezone": epoch["source_timezone"],
                "version": epoch["version"],
            }
            for epoch in epochs
        ],
        "_epochs": epochs,
        "active_points": points,
        "point_errors": point_errors,
        "history": [
            {
                "version": row["version"],
                "at": _iso(row["at"]),
                "old": row["old"],
                "new": row["new"],
            }
            for row in history
        ],
        "history_errors": history_errors,
        "core_blockers": sorted(set(core_blockers)),
    }


def _epoch_for(creation: Any, evidence: dict[str, Any]) -> dict[str, Any] | None:
    parsed = _as_datetime(creation)
    if parsed is None:
        return None
    matches = []
    for epoch in evidence["_epochs"]:
        if epoch["start"] is not None and parsed < epoch["start"]:
            continue
        if epoch["end"] is not None and parsed >= epoch["end"]:
            continue
        matches.append(epoch)
    if len(matches) != 1:
        return None
    return matches[0]


def _payload_value(row: Any, field: str, payload_field: str) -> str | None:
    payload = row.get("source_payload_json") if hasattr(row, "get") else None
    if not payload:
        return None
    try:
        payload = payload if isinstance(payload, dict) else json.loads(payload)
    except (TypeError, ValueError):
        return None
    value = payload.get(payload_field)
    if value in (None, "") and field == "posting_datetime":
        value = payload.get("createdAt")
    return value


def _external_utc_naive(value: str) -> datetime | None:
    from raspechatka.time_contract import parse_external_instant

    try:
        return parse_external_instant(value).astimezone(UTC).replace(tzinfo=None)
    except (TypeError, TimeContractError, ValueError):
        return None


def _add_entry(entries, unresolved, *, doctype, name, field, repair_class, before, after, reason):
    unchanged = before == after if field == "business_date" else _same_datetime(before, after)
    if unchanged:
        return
    entries.append(
        {
            "doctype": doctype,
            "name": name,
            "field": field,
            "repair_class": repair_class,
            "before": _iso(before) if field != "business_date" else str(before or ""),
            "after": _iso(after) if field != "business_date" else str(after or ""),
            "reason": reason,
        }
    )


def _add_unresolved(unresolved, *, doctype, name, field, repair_class, reason, before=None):
    unresolved.append(
        {
            "doctype": doctype,
            "name": name,
            "field": field,
            "repair_class": repair_class,
            "before": _iso(before) if field != "business_date" else str(before or ""),
            "reason": reason,
        }
    )


def _safe_pos_row(row: Any, source_field: str, source_value: str) -> bool:
    value = row.get(source_field) if hasattr(row, "get") else None
    if source_value == "set":
        return bool(value)
    return str(value or "") == source_value


def _plan_pos_fields(evidence, entries, unresolved, already_correct):
    target = evidence["target_timezone"]
    for doctype, field, source_field, source_value, payload_field in POS_UTC_REGISTRY:
        if not frappe.db.exists("DocType", doctype):
            continue
        has_payload_field = frappe.get_meta(doctype).has_field("source_payload_json")
        fields = ["name", field, "creation", source_field]
        if has_payload_field:
            fields.append("source_payload_json")
        rows = frappe.get_all(
            doctype,
            filters={source_field: ["is", "set"]} if source_value == "set" else {source_field: source_value},
            fields=fields,
            order_by="name asc",
            limit_page_length=100000,
        )
        for row in rows:
            before = row.get(field)
            if not before:
                continue
            raw = _payload_value(row, field, payload_field)
            if has_payload_field and not raw:
                _add_unresolved(
                    unresolved,
                    doctype=doctype,
                    name=row.name,
                    field=field,
                    repair_class="pos_utc_as_naive",
                    before=before,
                    reason="POS payload evidence is missing for this timestamp",
                )
                continue
            if raw:
                direct = _external_utc_naive(raw)
                try:
                    expected = external_instant_to_site_naive(raw, target)
                except TimeContractError:
                    expected = None
                if expected is not None and _same_datetime(before, expected):
                    already_correct.append(
                        {"doctype": doctype, "name": row.name, "field": field, "reason": "stored value matches RFC3339 source"}
                    )
                    continue
                if direct is None or not _same_datetime(before, direct):
                    _add_unresolved(
                        unresolved,
                        doctype=doctype,
                        name=row.name,
                        field=field,
                        repair_class="pos_utc_as_naive",
                        before=before,
                        reason="stored value does not match proven UTC wall-clock source",
                    )
                    continue
            try:
                after = _pos_utc_wall_clock(before, target)
                _add_entry(
                    entries,
                    unresolved,
                    doctype=doctype,
                    name=row.name,
                    field=field,
                    repair_class="pos_utc_as_naive",
                    before=before,
                    after=after,
                    reason="legacy POS path assigned an external instant directly to Frappe Datetime",
                )
            except TimeContractError as exc:
                _add_unresolved(
                    unresolved,
                    doctype=doctype,
                    name=row.name,
                    field=field,
                    repair_class="pos_utc_as_naive",
                    before=before,
                    reason=str(exc),
                )


def _plan_pos_site_fields(evidence, entries, unresolved):
    source = evidence["source_default_timezone"]
    target = evidence["target_timezone"]
    if source == target:
        return
    for doctype, field, source_field, source_value in POS_SITE_REGISTRY:
        if not frappe.db.exists("DocType", doctype):
            continue
        rows = frappe.get_all(
            doctype,
            filters={source_field: source_value},
            fields=["name", field, "creation"],
            order_by="name asc",
            limit_page_length=100000,
        )
        for row in rows:
            epoch = _epoch_for(row.creation, evidence)
            row_source = epoch["source_timezone"] if epoch else source
            if not epoch:
                _add_unresolved(
                    unresolved,
                    doctype=doctype,
                    name=row.name,
                    field=field,
                    repair_class="old_site_wall_clock",
                    before=row.get(field),
                    reason="creation does not fit one unambiguous System Settings timezone epoch",
                )
                continue
            if row_source == target:
                continue
            try:
                after = _site_wall_clock(row.get(field), row_source, target)
                _add_entry(
                    entries,
                    unresolved,
                    doctype=doctype,
                    name=row.name,
                    field=field,
                    repair_class="old_site_wall_clock",
                    before=row.get(field),
                    after=after,
                    reason="POS-created stock document uses server site wall clock",
                )
            except TimeContractError as exc:
                _add_unresolved(
                    unresolved,
                    doctype=doctype,
                    name=row.name,
                    field=field,
                    repair_class="old_site_wall_clock",
                    before=row.get(field),
                    reason=str(exc),
                )


def _plan_standard_fields(evidence, entries, unresolved):
    target = evidence["target_timezone"]
    source_target_same = all(epoch["source_timezone"] == target for epoch in evidence["_epochs"])
    for doctype in APP_OWNED_CREATION_MODIFIED_DOCTYPES:
        if not frappe.db.exists("DocType", doctype):
            continue
        rows = frappe.get_all(
            doctype,
            fields=["name", "creation", "modified"],
            order_by="name asc",
            limit_page_length=100000,
        )
        for row in rows:
            epoch = _epoch_for(row.creation, evidence)
            if not epoch:
                if not source_target_same:
                    for field in ("creation", "modified"):
                        _add_unresolved(
                            unresolved,
                            doctype=doctype,
                            name=row.name,
                            field=field,
                            repair_class="old_site_wall_clock",
                            before=row.get(field),
                            reason="creation does not fit one unambiguous System Settings timezone epoch",
                        )
                continue
            source = epoch["source_timezone"]
            if source == target:
                continue
            for field in ("creation", "modified"):
                try:
                    after = _site_wall_clock(row.get(field), source, target)
                    _add_entry(
                        entries,
                        unresolved,
                        doctype=doctype,
                        name=row.name,
                        field=field,
                        repair_class="old_site_wall_clock",
                        before=row.get(field),
                        after=after,
                        reason=f"server-generated {field} in proven site timezone epoch",
                    )
                except TimeContractError as exc:
                    _add_unresolved(
                        unresolved,
                        doctype=doctype,
                        name=row.name,
                        field=field,
                        repair_class="old_site_wall_clock",
                        before=row.get(field),
                        reason=str(exc),
                    )


def _plan_client_registered_at(evidence, entries, unresolved):
    target = evidence["target_timezone"]
    if not frappe.db.exists("DocType", "Client"):
        return
    rows = frappe.get_all(
        "Client",
        fields=["name", "creation", "registered_at"],
        order_by="name asc",
        limit_page_length=100000,
    )
    for row in rows:
        registered = _as_datetime(row.registered_at)
        creation = _as_datetime(row.creation)
        if not registered or not creation:
            continue
        if abs(registered - creation) > CLIENT_REGISTERED_TOLERANCE:
            _add_unresolved(
                unresolved,
                doctype="Client",
                name=row.name,
                field="registered_at",
                repair_class="old_site_wall_clock",
                before=registered,
                reason="registered_at is not close enough to creation; may be imported/user-entered",
            )
            continue
        epoch = _epoch_for(creation, evidence)
        if not epoch or epoch["source_timezone"] == target:
            continue
        try:
            after = _site_wall_clock(registered, epoch["source_timezone"], target)
            _add_entry(
                entries,
                unresolved,
                doctype="Client",
                name=row.name,
                field="registered_at",
                repair_class="old_site_wall_clock",
                before=registered,
                after=after,
                reason="registered_at matches server-generated creation within tolerance",
            )
        except TimeContractError as exc:
            _add_unresolved(
                unresolved,
                doctype="Client",
                name=row.name,
                field="registered_at",
                repair_class="old_site_wall_clock",
                before=registered,
                reason=str(exc),
            )


def _reference_timestamp(doctype, action_type, doc):
    if doctype == "Sales Shift":
        field = "closed_at" if action_type == "CLOSE_SHIFT" else "opened_at"
    elif doctype in {"Sales Receipt", "Cash Movement"}:
        field = "posting_datetime"
    else:
        return None, None
    return field, doc.get(field)


def _plan_cashier_actions(evidence, entries, unresolved):
    actions = frappe.get_all(
        "Cashier Action",
        fields=["name", "action_datetime", "action_type", "reference_doctype", "reference_document"],
        order_by="name asc",
        limit_page_length=100000,
    )
    target = evidence["target_timezone"]
    planned = {(entry["doctype"], entry["name"], entry["field"]): entry for entry in entries}
    for action in actions:
        if not action.reference_doctype or not action.reference_document:
            _add_unresolved(
                unresolved,
                doctype="Cashier Action",
                name=action.name,
                field="action_datetime",
                repair_class="cashier_action_rederive",
                before=action.action_datetime,
                reason="missing reference document",
            )
            continue
        if action.reference_doctype not in {"Sales Shift", "Sales Receipt", "Cash Movement"}:
            _add_unresolved(
                unresolved,
                doctype="Cashier Action",
                name=action.name,
                field="action_datetime",
                repair_class="cashier_action_rederive",
                before=action.action_datetime,
                reason="reference document is outside proven sales registry",
            )
            continue
        reference_fields = (
            ["name", "source", "opened_at", "closed_at"]
            if action.reference_doctype == "Sales Shift"
            else ["name", "source", "posting_datetime"]
        )
        doc = frappe.db.get_value(
            action.reference_doctype,
            action.reference_document,
            reference_fields,
            as_dict=True,
        )
        if not doc or doc.source != "POS":
            _add_unresolved(
                unresolved,
                doctype="Cashier Action",
                name=action.name,
                field="action_datetime",
                repair_class="cashier_action_rederive",
                before=action.action_datetime,
                reason="referenced document is not a proven POS record",
            )
            continue
        field, reference_value = _reference_timestamp(action.reference_doctype, action.action_type, doc)
        key = (action.reference_doctype, action.reference_document, field)
        planned_value = planned.get(key, {}).get("after") if key in planned else None
        if reference_value and not planned_value and _same_datetime(action.action_datetime, reference_value):
            continue
        if not planned_value:
            _add_unresolved(
                unresolved,
                doctype="Cashier Action",
                name=action.name,
                field="action_datetime",
                repair_class="cashier_action_rederive",
                before=action.action_datetime,
                reason="referenced timestamp was not independently repaired or verified",
            )
            continue
        desired = planned_value or reference_value
        if not desired:
            _add_unresolved(
                unresolved,
                doctype="Cashier Action",
                name=action.name,
                field="action_datetime",
                repair_class="cashier_action_rederive",
                before=action.action_datetime,
                reason="referenced timestamp is empty",
            )
            continue
        if isinstance(desired, str):
            desired = get_datetime(desired)
        _add_entry(
            entries,
            unresolved,
            doctype="Cashier Action",
            name=action.name,
            field="action_datetime",
            repair_class="cashier_action_rederive",
            before=action.action_datetime,
            after=desired,
            reason="re-derived from repaired referenced POS document",
        )


def _point_timezone_map(evidence):
    mapping = {row["name"]: row["timezone"] for row in evidence["active_points"]}
    rows = frappe.get_all(
        "Business Point",
        fields=["name", "timezone"],
        limit_page_length=100000,
    )
    errors = []
    for row in rows:
        if row.name in mapping:
            continue
        try:
            mapping[row.name] = resolve_point_timezone(row.timezone, evidence["target_timezone"])
        except TimeContractError as exc:
            errors.append(f"Business Point {row.name}: {exc}")
    return mapping, errors


def _plan_business_dates(evidence, entries, unresolved):
    target = evidence["target_timezone"]
    point_zones, point_errors = _point_timezone_map(evidence)
    for doctype, instant_field in BUSINESS_DATE_REGISTRY:
        if not frappe.db.exists("DocType", doctype):
            continue
        rows = frappe.get_all(
            doctype,
            fields=["name", "business_point", "business_date", instant_field],
            order_by="name asc",
            limit_page_length=100000,
        )
        planned = {(entry["doctype"], entry["name"], entry["field"]): entry for entry in entries}
        for row in rows:
            zone = point_zones.get(row.business_point)
            if not zone:
                _add_unresolved(
                    unresolved,
                    doctype=doctype,
                    name=row.name,
                    field="business_date",
                    repair_class="business_date_backfill",
                    before=row.business_date,
                    reason="Business Point timezone is missing or invalid",
                )
                continue
            instant = planned.get((doctype, row.name, instant_field), {}).get("after") or row.get(instant_field)
            if not instant:
                continue
            try:
                desired = site_naive_to_target_date(get_datetime(instant), zone, target)
            except (TypeError, TimeContractError, ValueError) as exc:
                _add_unresolved(
                    unresolved,
                    doctype=doctype,
                    name=row.name,
                    field="business_date",
                    repair_class="business_date_backfill",
                    before=row.business_date,
                    reason=str(exc),
                )
                continue
            _add_entry(
                entries,
                unresolved,
                doctype=doctype,
                name=row.name,
                field="business_date",
                repair_class="business_date_backfill",
                before=row.business_date,
                after=desired,
                reason="derived from canonical site-naive instant and Business Point timezone",
            )
    if point_errors:
        unresolved.extend(
            {
                "doctype": "Business Point",
                "name": "",
                "field": "timezone",
                "repair_class": "business_date_backfill",
                "before": "",
                "reason": reason,
            }
            for reason in point_errors
        )


def _plan_counts(entries, unresolved):
    counts = {}
    for row in entries:
        counts[row["repair_class"]] = counts.get(row["repair_class"], 0) + 1
    unresolved_counts = {}
    for row in unresolved:
        unresolved_counts[row["repair_class"]] = unresolved_counts.get(row["repair_class"], 0) + 1
    return {"safe_changes": counts, "unresolved": unresolved_counts}


def _marker_file():
    files = frappe.get_all(
        "File",
        filters={"file_name": REPORT_FILE_NAME, "is_private": 1},
        fields=["name", "file_url"],
        order_by="creation desc",
        limit_page_length=1,
    )
    return files[0] if files else None


def build_repair_plan() -> dict[str, Any]:
    """Build a deterministic, non-mutating repair plan."""
    cutoff = datetime.now(timezone.utc)
    evidence = _site_evidence()
    try:
        evidence["effective_before"] = validate_timezone(get_system_timezone())
    except Exception as exc:
        evidence["core_blockers"].append(f"cannot read effective Frappe timezone: {exc}")
    if (
        evidence["configured_timezone"]
        and evidence["effective_before"]
        and evidence["configured_timezone"] != evidence["effective_before"]
    ):
        evidence["core_blockers"].append(
            "configured System Settings.time_zone disagrees with Frappe effective timezone"
        )

    entries = []
    unresolved = []
    already_correct = []
    _plan_standard_fields(evidence, entries, unresolved)
    _plan_client_registered_at(evidence, entries, unresolved)
    _plan_pos_fields(evidence, entries, unresolved, already_correct)
    _plan_pos_site_fields(evidence, entries, unresolved)
    _plan_cashier_actions(evidence, entries, unresolved)
    _plan_business_dates(evidence, entries, unresolved)

    entries.sort(key=lambda row: (row["doctype"], row["name"], row["field"], row["repair_class"]))
    unresolved.sort(key=lambda row: (row["doctype"], row["name"], row["field"], row["repair_class"], row["reason"]))
    already_correct.sort(key=lambda row: (row["doctype"], row["name"], row["field"]))
    plan = {
        "contract_version": REPAIR_CONTRACT_VERSION,
        "cutoff_utc": cutoff.isoformat().replace("+00:00", "Z"),
        "configured_site_timezone": evidence["configured_raw"],
        "effective_site_timezone_before": evidence["effective_before"],
        "target_site_timezone": evidence["target_timezone"],
        "source_default_timezone": evidence["source_default_timezone"],
        "version_evidence": {
            "history": evidence["history"],
            "epochs": evidence["epochs"],
            "history_errors": evidence["history_errors"],
        },
        "point_evidence": {
            "active_points": evidence["active_points"],
            "errors": evidence["point_errors"],
        },
        "modified_cursor_audit": {
            "registry": list(MODIFIED_CURSOR_REGISTRY),
            "affected": [],
            "note": "Targeted raspechatka/** search found no app-owned modified cursor requiring reset.",
        },
        "counts": _plan_counts(entries, unresolved),
        "safe_changes": entries,
        "already_correct": already_correct[:100],
        "unresolved": unresolved[:10000],
        "unresolved_total": len(unresolved),
        "core_blockers": sorted(set(evidence["core_blockers"])),
    }
    plan["plan_hash"] = hashlib.sha256(_json(plan).encode("utf-8")).hexdigest()
    return plan


def _assert_preconditions(plan):
    current_raw = frappe.db.get_single_value("System Settings", "time_zone") or None
    if current_raw != plan["configured_site_timezone"]:
        raise frappe.ValidationError("System Settings.time_zone changed after dry-run plan")
    for entry in plan["safe_changes"]:
        current = frappe.db.get_value(entry["doctype"], entry["name"], entry["field"])
        expected = entry["before"]
        if entry["field"] == "business_date":
            current_value = str(current or "")
            expected_value = str(expected or "")
        else:
            current_value = _iso(current) or ""
            expected_value = str(expected or "")
        if current_value != expected_value:
            raise frappe.ValidationError(
                f"{entry['doctype']} {entry['name']} {entry['field']} changed after dry-run plan"
            )


def _write_report(report: dict[str, Any]):
    doc = frappe.get_doc(
        {
            "doctype": "File",
            "file_name": REPORT_FILE_NAME,
            "is_private": 1,
            "attached_to_doctype": "System Settings",
            "attached_to_name": "System Settings",
            "content": _json(report),
        }
    )
    doc.insert(ignore_permissions=True)
    return doc.name


def apply_repair_plan(plan: dict[str, Any] | None = None):
    """Apply one verified plan; repeated calls use the private report marker."""
    marker = _marker_file()
    if marker:
        return {"status": "already_applied", "report_file": marker.name}

    plan = plan or build_repair_plan()
    if plan["core_blockers"]:
        raise frappe.ValidationError(
            "DEV-161 historical repair refused: " + "; ".join(plan["core_blockers"])
        )
    _assert_preconditions(plan)

    try:
        target = plan["target_site_timezone"]
        if target != plan["effective_site_timezone_before"]:
            frappe.db.set_single_value("System Settings", "time_zone", target)
        changes = plan["safe_changes"]
        for start in range(0, len(changes), BATCH_SIZE):
            for entry in changes[start : start + BATCH_SIZE]:
                value = (
                    entry["after"]
                    if entry["field"] == "business_date"
                    else get_datetime(entry["after"])
                )
                frappe.db.set_value(
                    entry["doctype"],
                    entry["name"],
                    entry["field"],
                    value,
                    update_modified=False,
                )
        report = {
            "contract_version": REPAIR_CONTRACT_VERSION,
            "applied_status": "applied",
            "cutoff_utc": plan["cutoff_utc"],
            "plan_hash": plan["plan_hash"],
            "source_timezone": plan["source_default_timezone"],
            "target_timezone": plan["target_site_timezone"],
            "configured_timezone_before": plan["configured_site_timezone"],
            "effective_timezone_before": plan["effective_site_timezone_before"],
            "counts": plan["counts"],
            "examples_before_after": plan["safe_changes"][:50],
            "already_correct": plan["already_correct"][:100],
            "unresolved_total": plan["unresolved_total"],
            "unresolved": plan["unresolved"],
            "version_evidence": plan["version_evidence"],
            "point_evidence": plan["point_evidence"],
            "modified_cursor_audit": plan["modified_cursor_audit"],
        }
        report_file = _write_report(report)
        frappe.clear_cache()
        return {"status": "applied", "report_file": report_file, "plan_hash": plan["plan_hash"]}
    except Exception:
        frappe.db.rollback()
        raise


def execute():
    """Patch entry point."""
    return apply_repair_plan()
