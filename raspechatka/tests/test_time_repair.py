from datetime import datetime
from pathlib import Path

import pytest

from raspechatka.time_contract import external_instant_to_site_naive, site_naive_to_target_date
from raspechatka.time_repair import (
    REPAIR_CONTRACT_VERSION,
    _ambiguous_local,
    _pos_utc_wall_clock,
    _same_datetime,
    _site_wall_clock,
)


def test_asia_kolkata_server_wall_clock_repairs_to_moscow():
    before = datetime(2026, 1, 15, 23, 30)
    assert _site_wall_clock(before, "Asia/Kolkata", "Europe/Moscow") == datetime(
        2026, 1, 15, 21, 0
    )


def test_utc_naive_pos_repairs_to_moscow():
    assert _pos_utc_wall_clock(datetime(2026, 1, 15, 15, 0), "Europe/Moscow") == datetime(
        2026, 1, 15, 18, 0
    )


def test_already_correct_pos_value_is_not_shifted():
    stored = external_instant_to_site_naive("2026-01-15T15:00:00Z", "Europe/Moscow")
    assert _same_datetime(stored, datetime(2026, 1, 15, 18, 0))


def test_imported_ambiguous_dst_wall_clock_is_rejected():
    value = datetime(2026, 11, 1, 1, 30)
    assert _ambiguous_local(value, "America/New_York")
    with pytest.raises(ValueError):
        _site_wall_clock(value, "America/New_York", "Europe/Moscow")


def test_business_date_backfill_uses_point_timezone():
    stored_site_value = datetime(2026, 9, 21, 17, 1)
    assert site_naive_to_target_date(
        stored_site_value, "Asia/Vladivostok", "Europe/Moscow"
    ).isoformat() == "2026-09-22"


def test_repair_source_is_explicit_and_side_effect_safe():
    source = (Path(__file__).parents[1] / "time_repair.py").read_text()
    assert REPAIR_CONTRACT_VERSION in source
    assert "safe_changes" in source and "unresolved" in source
    assert "File" in source and "is_private" in source
    assert "frappe.db.rollback()" in source
    assert ".submit(" not in source
    assert ".cancel(" not in source
    assert "subtract" not in source.lower()
