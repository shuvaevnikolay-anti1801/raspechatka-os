from pathlib import Path

from unittest import TestCase

from raspechatka.time_contract import TimeContractError, validate_timezone
ROOT = Path(__file__).parents[1]

_ASSERTIONS = TestCase()


def test_user_timezone_save_uses_linked_frappe_user_without_profile_field():
    source = (ROOT / "api" / "users.py").read_text()
    assert 'frappe.db.get_value("User", profile.system_user, "time_zone")' in source
    assert '"User",' in source and '"time_zone",' in source
    assert '"time_zone" not in (' not in source


def test_invalid_user_timezone_is_rejected_before_save():
    source = (ROOT / "api" / "users.py").read_text()
    with _ASSERTIONS.assertRaises(TimeContractError):
        validate_timezone("Not/IANA")
    assert "_validated_user_timezone" in source
    assert "Недопустимый IANA-часовой пояс" in source


def test_timezone_api_and_diagnostics_keep_admin_boundary():
    users = (ROOT / "api" / "users.py").read_text()
    diagnostics = (ROOT / "api" / "time.py").read_text()
    assert '@access_contract(area="page.references.users", action="admin", scope="user")' in users
    assert '@access_contract(area="page.references.users", action="admin", scope="user")' in diagnostics
    assert 'require_access("page.references.users", "admin")' in diagnostics
    assert 'filters["name"] = ["in", scope["points"] or ["__none__"]]' in diagnostics


def test_diagnostics_distinguish_site_user_and_point_timezones():
    diagnostics = (ROOT / "api" / "time.py").read_text()
    assert '"configured_site_timezone"' in diagnostics
    assert '"effective_site_timezone"' in diagnostics
    assert '"configured_timezone": configured_user' in diagnostics
    assert '"effective_timezone": effective_user' in diagnostics
    assert '"configured_timezone": raw_timezone' in diagnostics
    assert '"legacy_frappe_fallback"' in diagnostics
    assert '"invalid_point_timezone"' in diagnostics


def test_users_page_has_system_fallback_selector_and_read_only_diagnostics():
    page = (ROOT.parent / "frontend" / "src" / "pages" / "UsersPage.vue").read_text()
    assert "Системный — {{ options.system_timezone" in page
    assert "raspechatka.api.time.get_time_diagnostics" in page
    assert "Время системы" in page
    assert "System Settings" not in page


def test_legacy_india_fallback_is_repaired_only_on_moscow_site():
    patch = (ROOT / "patches" / "v1_0" / "repair_legacy_user_timezones.py").read_text()
    assert 'LEGACY_FRAPPE_FALLBACK = "Asia/Kolkata"' in patch
    assert 'CANONICAL_SITE_TIMEZONE = "Europe/Moscow"' in patch
    assert "get_effective_site_timezone() != CANONICAL_SITE_TIMEZONE" in patch
    assert 'filters={"time_zone": LEGACY_FRAPPE_FALLBACK}' in patch
    assert '"time_zone",' in patch
    assert '""' in patch
