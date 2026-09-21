from datetime import date, datetime

from unittest import TestCase

from raspechatka.time_contract import (
    TimeContractError,
    configured_site_timezone,
    effective_site_timezone,
    external_instant_to_site_naive,
    parse_external_instant,
    point_local_date_bounds_to_site_naive,
    resolve_point_timezone,
    site_naive_to_target_date,
    site_naive_to_target_datetime,
    site_naive_to_utc_rfc3339,
    validate_timezone,
)

_ASSERTIONS = TestCase()


def test_moscow_frappe_naive_round_trip():
    naive = datetime(2026, 9, 21, 18, 0, 0)
    assert site_naive_to_utc_rfc3339(naive, "Europe/Moscow") == "2026-09-21T15:00:00Z"
    assert external_instant_to_site_naive("2026-09-21T15:00:00.000Z", "Europe/Moscow") == naive


def test_external_utc_instant_becomes_moscow_wall_clock():
    assert external_instant_to_site_naive(
        "2026-09-21T15:00:00Z", "Europe/Moscow"
    ) == datetime(2026, 9, 21, 18, 0, 0)


def test_target_user_timezone_conversion_and_local_date():
    value = datetime(2026, 7, 1, 18, 0, 0)
    converted = site_naive_to_target_datetime(value, "America/New_York", "Europe/Moscow")
    assert converted.isoformat() == "2026-07-01T11:00:00-04:00"
    assert site_naive_to_target_date(value, "America/New_York", "Europe/Moscow") == date(
        2026, 7, 1
    )


def test_point_local_date_bounds_handle_midnight_crossing():
    start, end = point_local_date_bounds_to_site_naive(
        date(2026, 1, 2), "Asia/Vladivostok", "Europe/Moscow"
    )
    assert start == datetime(2026, 1, 1, 17, 0, 0)
    assert end == datetime(2026, 1, 2, 17, 0, 0)


def test_point_local_bounds_handle_dst_change():
    start, end = point_local_date_bounds_to_site_naive(
        date(2026, 3, 8), "America/New_York", "Europe/Moscow"
    )
    assert start == datetime(2026, 3, 8, 8, 0, 0)
    assert end == datetime(2026, 3, 9, 7, 0, 0)


def test_timezones_are_validated_and_point_fallback_is_explicit():
    with _ASSERTIONS.assertRaises(TimeContractError):
        validate_timezone("Not/An_IANA_Zone")
    assert configured_site_timezone("") is None
    assert effective_site_timezone("UTC") == "UTC"
    assert resolve_point_timezone(None, "Europe/Moscow") == "Europe/Moscow"
    assert resolve_point_timezone("Europe/Samara", "Europe/Moscow") == "Europe/Samara"


def test_offsetless_instants_and_date_only_values_are_rejected():
    with _ASSERTIONS.assertRaises(TimeContractError):
        parse_external_instant("2026-09-21T15:00:00")
    with _ASSERTIONS.assertRaises(TypeError):
        site_naive_to_utc_rfc3339(date(2026, 9, 21), "UTC")
    with _ASSERTIONS.assertRaises(TypeError):
        point_local_date_bounds_to_site_naive(
            datetime(2026, 9, 21), "UTC", "UTC"
        )
