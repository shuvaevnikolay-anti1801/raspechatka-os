import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_user_profile_links_to_real_frappe_role():
	doctype = json.loads(
		(
			ROOT / "raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.json"
		).read_text()
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


def test_custom_role_management_keeps_stable_role_id_and_checks_users():
	source = (ROOT / "raspechatka/access.py").read_text(encoding="utf-8")
	rename = source[source.index("def rename_work_role") : source.index("def delete_work_role")]
	delete = source[source.index("def delete_work_role") : source.index("def save_access_settings")]
	assert 'frappe.db.set_value("Role", role_doc.name, "role_name", new_label)' in rename
	assert 'frappe.db.get_value("Role", role_doc.name, "role_name")' in rename
	assert "saved_label != new_label" in rename
	assert "rename_doc" not in rename
	assert "_validate_manageable_role(role_doc)" in rename
	assert "_assigned_role_users(role_doc.name)" in delete
	assert 'frappe.delete_doc("Role", role_doc.name' in delete
	assert '"deleted": False, "users": users' in delete


def test_access_matrix_exposes_edit_delete_controls_for_work_roles():
	page = (ROOT / "frontend/src/pages/AccessSettingsPage.vue").read_text(encoding="utf-8")
	assert "is_new: true" in page
	assert "Новая рабочая роль" not in page
	assert "newRoleName" not in page
	assert "rename_work_role" in page
	assert "create_work_role" in page
	assert "delete_work_role" in page
	assert "blockedUsers" in page
	assert "role.label = result.label" in page
	assert "Сервер не подтвердил новое название роли" in page
	assert "role-lock" not in page


def test_system_work_roles_can_be_renamed_but_not_deleted():
	security = (ROOT / "raspechatka/security.py").read_text(encoding="utf-8")
	source = (ROOT / "raspechatka/access.py").read_text(encoding="utf-8")
	rows = source[source.index("def get_matrix_role_rows") : source.index("def _normalize_role_name")]
	rename = source[source.index("def rename_work_role") : source.index("def delete_work_role")]
	delete = source[source.index("def delete_work_role") : source.index("def save_access_settings")]
	assert "SYSTEM_WORK_ROLES = frozenset" in security
	for role in (
		"Raspechatka Network Admin",
		"Raspechatka Franchise Owner",
		"Raspechatka Point Manager",
		"Raspechatka Cashier",
	):
		assert role in security
	assert '"editable": True' in rows
	assert '"deletable": role_id not in SYSTEM_WORK_ROLES' in rows
	assert 'frappe.db.set_value("Role", role_doc.name, "role_name", new_label)' in rename
	assert "rename_doc" not in rename
	assert "role_doc.name in SYSTEM_WORK_ROLES" in delete
	assert "frappe.PermissionError" in delete
	assert delete.index("role_doc.name in SYSTEM_WORK_ROLES") < delete.index("_assigned_role_users")
	assert 'frappe.delete_doc("Role", role_doc.name' in delete


def test_cashier_web_matrix_is_fixed_to_none_in_backend_and_ui():
	source = (ROOT / "raspechatka/access.py").read_text(encoding="utf-8")
	page = (ROOT / "frontend/src/pages/AccessSettingsPage.vue").read_text(encoding="utf-8")
	save = source[source.index("def save_access_settings") :]
	assert '"fixed_page_level": "None" if role_id == CASHIER_ROLE else None' in source
	assert 'role == CASHIER_ROLE and area.startswith("page.")' in source
	assert 'role == CASHIER_ROLE and level != "None"' in save
	assert "Роль кассира предназначена только для POS" in save
	assert "fixedAccessLevel(role, area)" in page
	assert ':disabled="isProtected(role, area)"' in page
	assert 'v-if="role.deletable"' in page


def test_users_page_uses_dynamic_work_roles_only():
	page = (ROOT / "frontend/src/pages/UsersPage.vue").read_text(encoding="utf-8")
	api = (ROOT / "raspechatka/api/users.py").read_text(encoding="utf-8")
	assert "options.access_roles" in page
	assert 'value="Network Admin"' not in page
	assert '"access_roles"' in api
	assert "get_matrix_role_rows()" in api


def test_network_admin_guard_and_sticky_header_remain():
	page = (ROOT / "frontend/src/pages/AccessSettingsPage.vue").read_text(encoding="utf-8")
	backend = (ROOT / "raspechatka/access.py").read_text(encoding="utf-8")
	assert "position: sticky" in page
	assert '"fixed_areas": {ACCESS_SETTINGS_AREA: "Admin"}' in backend
	assert "role.fixed_areas?.[area.area]" in page
	assert "role == NETWORK_ADMIN_ROLE and area == ACCESS_SETTINGS_AREA" in backend
	assert "settings-note" not in page


def test_legacy_profile_migration_is_registered_and_idempotent():
	patches = (ROOT / "raspechatka/patches.txt").read_text(encoding="utf-8")
	patch = (ROOT / "raspechatka/patches/v1_0/migrate_user_profiles_to_dynamic_roles.py").read_text(
		encoding="utf-8"
	)
	assert patches.count("raspechatka.patches.v1_0.migrate_user_profiles_to_dynamic_roles") == 1
	assert '"Cashier": "Raspechatka Cashier"' in patch
	assert 'frappe.db.exists("Role", role)' in patch


def test_cashier_page_rule_normalization_patch_is_registered_and_idempotent():
	patches = (ROOT / "raspechatka/patches.txt").read_text(encoding="utf-8")
	patch = (ROOT / "raspechatka/patches/v1_0/enforce_cashier_web_page_none.py").read_text(encoding="utf-8")
	patch_name = "raspechatka.patches.v1_0.enforce_cashier_web_page_none"
	assert patches.count(patch_name) == 1
	assert "synchronize_access_pages(copy_legacy_rules=True)" in patch
