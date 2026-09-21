from datetime import date, datetime
import json
from pathlib import Path

import pytest

from raspechatka.time_contract import (
    TimeContractError,
    external_instant_to_site_naive,
    point_local_date_bounds_to_site_naive,
    site_naive_to_target_date,
    site_naive_to_target_datetime,
    site_naive_to_utc_rfc3339,
    validate_timezone,
)


def test_moscow_site_naive_round_trip_is_utc_identity():
    site_value = datetime(2026, 1, 15, 18, 0)
    assert site_naive_to_utc_rfc3339(site_value, "Europe/Moscow") == "2026-01-15T15:00:00Z"
    assert external_instant_to_site_naive("2026-01-15T15:00:00Z", "Europe/Moscow") == site_value


def test_target_user_timezone_conversion_uses_site_wall_clock():
    site_value = datetime(2026, 1, 15, 18, 0)
    converted = site_naive_to_target_datetime(site_value, "Europe/Berlin", "Europe/Moscow")
    assert converted.isoformat() == "2026-01-15T16:00:00+01:00"


def test_point_local_midnight_changes_business_date_even_when_site_differs():
    assert site_naive_to_target_date(
        datetime(2026, 9, 21, 16, 59), "Asia/Vladivostok", "Europe/Moscow"
    ) == date(2026, 9, 21)
    assert site_naive_to_target_date(
        datetime(2026, 9, 21, 17, 1), "Asia/Vladivostok", "Europe/Moscow"
    ) == date(2026, 9, 22)


def test_dst_point_day_bounds_use_zoneinfo_transitions():
    start, end = point_local_date_bounds_to_site_naive(
        date(2026, 3, 8), "America/New_York", "Europe/Moscow"
    )
    assert start == datetime(2026, 3, 8, 8, 0)
    assert end == datetime(2026, 3, 9, 7, 0)


def test_point_bounds_require_date_not_datetime():
    with pytest.raises(TypeError):
        point_local_date_bounds_to_site_naive(
            datetime(2026, 3, 8), "America/New_York", "Europe/Moscow"
        )


def test_invalid_iana_timezone_is_rejected():
    with pytest.raises(TimeContractError):
        validate_timezone("Mars/Phobos")


def test_business_date_fields_are_additive_read_only_indexes():
    root = Path(__file__).parents[1] / "raspechatka_os" / "doctype"
    for doctype in ("sales_shift", "sales_receipt", "cash_movement", "cashier_action"):
        schema = json.loads((root / doctype / f"{doctype}.json").read_text())
        field = next(item for item in schema["fields"] if item["fieldname"] == "business_date")
        assert field["fieldtype"] == "Date"
        assert field["read_only"] == 1
        assert field["search_index"] == 1
