from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_cashier_profile_requires_linked_employee():
	profile = (
		ROOT / "raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.py"
	).read_text(encoding="utf-8")
	assert 'self.access_profile == "Raspechatka Cashier" and not self.linked_employee' in profile
	assert "Для работы в кассе выберите связанного сотрудника" in profile


def test_cashier_link_repair_patch_is_registered_and_conservative():
	patches = (ROOT / "raspechatka/patches.txt").read_text(encoding="utf-8")
	patch = (ROOT / "raspechatka/patches/v1_0/repair_cashier_employee_links.py").read_text(
		encoding="utf-8"
	)
	assert "raspechatka.patches.v1_0.repair_cashier_employee_links" in patches
	assert 'CASHIER_ROLE = "Raspechatka Cashier"' in patch
	assert '"system_user_profile"' in patch
	assert 'row.user == profile.system_user' in patch
	assert '_canonical_phone(row.phone) == phone' in patch
	assert 'row.business_entity == profile.business_entity' in patch
	assert "if len(candidates) != 1" in patch
	assert "doc.ensure_system_user()" in patch
