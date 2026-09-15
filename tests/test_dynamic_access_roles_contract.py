import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_user_profile_links_to_real_frappe_role():
	doctype = json.loads(
		(ROOT / "raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.json").read_text()
	)
	field = next(row for row in doctype["fields"] if row["fieldname"] == "access_profile")
	assert field["fieldtype"] == "Link"
	assert field["options"] == "Role"
	assert field["default"] == "Raspechatka Cashier"


def test_role_creation_is_server_validated_and_retry_safe():
	source = (ROOT / "raspechatka/access.py").read_text(encoding="utf-8")
	section = source[source.index("def create_work_role") : source.index("def save_access_settings")]
	assert "_require_access_settings_admin()" in section
	assert "_normalize_role_name" in section
	assert "PROTECTED_ROLES" in section
	assert "DuplicateEntryError" in section
	assert '"access_level": "None"' in source
	assert '"created": False' in section


def test_users_page_uses_dynamic_work_roles_only():
	page = (ROOT / "frontend/src/pages/UsersPage.vue").read_text(encoding="utf-8")
	api = (ROOT / "raspechatka/api/users.py").read_text(encoding="utf-8")
	assert "options.access_roles" in page
	assert 'value="Network Admin"' not in page
	assert '"access_roles"' in api
	assert "get_matrix_roles()" in api


def test_network_admin_guard_and_sticky_header_remain():
	page = (ROOT / "frontend/src/pages/AccessSettingsPage.vue").read_text(encoding="utf-8")
	backend = (ROOT / "raspechatka/access.py").read_text(encoding="utf-8")
	assert 'position: sticky' in page
	assert 'role.name === "Raspechatka Network Admin"' in page
	assert 'role == "Raspechatka Network Admin" and area == ACCESS_SETTINGS_AREA' in backend
	assert "settings-note" not in page


def test_legacy_profile_migration_is_registered_and_idempotent():
	patches = (ROOT / "raspechatka/patches.txt").read_text(encoding="utf-8")
	patch = (ROOT / "raspechatka/patches/v1_0/migrate_user_profiles_to_dynamic_roles.py").read_text(encoding="utf-8")
	assert patches.count("raspechatka.patches.v1_0.migrate_user_profiles_to_dynamic_roles") == 1
	assert '"Cashier": "Raspechatka Cashier"' in patch
	assert 'frappe.db.exists("Role", role)' in patch
