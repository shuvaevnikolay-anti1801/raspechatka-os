from datetime import datetime
from pathlib import Path

from unittest import TestCase

from raspechatka.time_contract import (
    TimeContractError,
    external_instant_to_site_naive,
    legacy_external_instant_to_site_naive,
    resolve_point_timezone,
    site_naive_to_utc_rfc3339,
)


_ASSERTIONS = TestCase()

APP_ROOT = Path(__file__).parents[1]
REPO_ROOT = Path(__file__).parents[2]


def test_moscow_storage_conversion_is_independent_of_point_timezone():
    instant = "2026-09-21T15:00:00.000Z"
    assert external_instant_to_site_naive(instant, "Europe/Moscow") == datetime(
        2026, 9, 21, 18, 0
    )
    # Point-local timezone is a business-day concern, not Frappe storage timezone.
    assert resolve_point_timezone("Asia/Vladivostok", "Europe/Moscow") == "Asia/Vladivostok"
    assert external_instant_to_site_naive(instant, "Europe/Moscow") == datetime(
        2026, 9, 21, 18, 0
    )


def test_pos_utc_round_trip_identity():
    naive = external_instant_to_site_naive(
        "2026-09-21T15:00:00.123Z", "Europe/Moscow"
    )
    assert site_naive_to_utc_rfc3339(naive, "Europe/Moscow") == "2026-09-21T15:00:00.123000Z"


def test_legacy_offsetless_path_is_explicit_but_v2_is_strict():
    assert legacy_external_instant_to_site_naive(
        "2026-09-21 18:00:00", "Europe/Moscow"
    ) == datetime(2026, 9, 21, 18, 0)
    with _ASSERTIONS.assertRaises(TimeContractError):
        external_instant_to_site_naive("2026-09-21T18:00:00", "Europe/Moscow")


def test_pos_timestamp_maps_cover_shift_receipt_order_and_cash_count():
    pos_source = (APP_ROOT / "api" / "pos.py").read_text(encoding="utf-8")
    v2_source = (APP_ROOT / "api" / "pos_v2.py").read_text(encoding="utf-8")
    for field in ("openedAt", "closedAt", "createdAt", "dueAt", "readyAt", "issuedAt", "countedAt"):
        assert field in pos_source or field in v2_source
    assert "_normalize_v2_payload(event.get" in v2_source
    assert "_legacy_pos_site_datetime(event.get" in pos_source
    assert '"createdAt": _pos_datetime_to_utc' in pos_source
    assert '"dueAt": _pos_datetime_to_utc' in pos_source
    assert '"readyAt": _pos_datetime_to_utc' in pos_source
    assert '"issuedAt": _pos_datetime_to_utc' in pos_source
    assert '"createdAt": _pos_datetime_to_utc' in v2_source
    assert '"posting_datetime": payload.get("createdAt")' in v2_source
    assert "str(row.posting_datetime)" not in v2_source
    assert "str(x.created_at" not in pos_source


def test_point_timezone_bootstrap_and_old_cached_state_are_compatible():
    pos_v2_source = (APP_ROOT / "api" / "pos_v2.py").read_text(encoding="utf-8")
    sync_source = (REPO_ROOT / "pos" / "src" / "main" / "sync.ts").read_text(encoding="utf-8")
    contracts_source = (REPO_ROOT / "pos" / "src" / "shared" / "contracts.ts").read_text(encoding="utf-8")
    assert '"timezone": resolve_point_timezone' in pos_v2_source
    assert "remote.point.timezone||LEGACY_POINT_TIMEZONE" in sync_source
    assert "pointTimezone:remote.pointTimezone??LEGACY_POINT_TIMEZONE" in sync_source
    assert "pointTimezone?: string" in contracts_source
