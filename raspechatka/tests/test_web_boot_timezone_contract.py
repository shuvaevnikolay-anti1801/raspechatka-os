from pathlib import Path


def test_web_boot_exposes_explicit_timezone_contract():
	source = (Path(__file__).parents[1] / "www" / "raspechatka.py").read_text(encoding="utf-8")
	assert '"system_timezone": system_timezone' in source
	assert '"effective_user_timezone": effective_user_timezone' in source
	assert '"user_timezone": effective_user_timezone' in source
	assert "user.time_zone or system_timezone" in source
	# Boot must not expose a second/private user timezone model.
	assert "user.settings" not in source
