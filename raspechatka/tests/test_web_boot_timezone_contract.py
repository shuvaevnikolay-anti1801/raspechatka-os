from pathlib import Path


def test_web_boot_exposes_explicit_timezone_contract():
	source = (Path(__file__).parents[1] / "www" / "raspechatka.py").read_text(encoding="utf-8")
	assert '"system_timezone": system_timezone' in source
	assert '"effective_user_timezone": effective_user_timezone' in source
	assert '"user_timezone": effective_user_timezone' in source
	assert "user.time_zone or system_timezone" in source
	# Boot must not expose a second/private user timezone model.
	assert "user.settings" not in source
	assert "get_effective_site_timezone" in source
	assert 'or "UTC"' not in source


def test_after_install_guard_is_narrow_and_explicit():
	source = (Path(__file__).parents[1] / "hooks.py").read_text(encoding="utf-8")
	assert 'after_install = "raspechatka.time_contract.ensure_site_timezone_after_install"' in source
