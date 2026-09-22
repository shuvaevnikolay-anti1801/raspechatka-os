from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_legacy_india_fallback_is_repaired_only_on_moscow_site():
	patch = (ROOT / "patches" / "v1_0" / "repair_legacy_user_timezones.py").read_text()
	patches = (ROOT / "patches.txt").read_text()
	assert 'LEGACY_FRAPPE_FALLBACK = "Asia/Kolkata"' in patch
	assert 'CANONICAL_SITE_TIMEZONE = "Europe/Moscow"' in patch
	assert "get_effective_site_timezone() != CANONICAL_SITE_TIMEZONE" in patch
	assert 'filters={"time_zone": LEGACY_FRAPPE_FALLBACK}' in patch
	assert '"time_zone",' in patch
	assert '"",' in patch
	assert "raspechatka.patches.v1_0.repair_legacy_user_timezones" in patches
