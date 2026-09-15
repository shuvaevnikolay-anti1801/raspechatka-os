from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_points_scope_requires_active_partner_entity_and_matching_active_points():
	profile = (
		ROOT / "raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.py"
	).read_text(encoding="utf-8")
	assert 'if not frappe.db.get_value("Organization", self.organization, "active")' in profile
	assert '"Business Entity", self.business_entity, ["organization", "active"]' in profile
	assert "entity.organization != self.organization" in profile
	assert '"Business Point", point, ["business_entity", "active"]' in profile
	assert "values.business_entity != self.business_entity" in profile
	assert 'if self.scope_type == "Points" and not self.assigned_points' in profile


def test_tampered_scope_is_rejected_for_create_update_and_sensitive_actions():
	api = (ROOT / "raspechatka/api/users.py").read_text(encoding="utf-8")
	assert 'scope_type = "Network" if profile.access_profile == "Raspechatka Network Admin"' in api
	assert 'target["entities"].issubset' in api
	assert 'target["points"].issubset' in api
	assert 'ranks = {"Points": 1, "Business Entity": 2, "Partner": 3, "Network": 4}' in api
	assert 'ranks.get(target["scope_type"], 0) > ranks.get(admin_scope.get("scope_type"), 0)' in api
	assert api.count("_get_manageable_profile(") >= 6
	save_section = api[api.index("def save_user_profile") : api.index("def set_user_active")]
	assert save_section.index("_require_profile_in_admin_scope(doc)") < save_section.index("doc.save")
	assert "_require_employee_in_admin_scope(doc.linked_employee)" in save_section
	assert "frappe.PermissionError" in api


def test_scope_resolution_fails_closed_for_inactive_or_mismatched_links():
	access = (ROOT / "raspechatka/access.py").read_text(encoding="utf-8")
	assert "if not organization_active:\n\t\t\treturn _empty_scope()" in access
	assert "entity.organization != profile.organization" in access
	assert "set(points) != set(assigned_points)" in access
	assert 'elif profile.scope_type == "Points":' in access
	assert "else:\n\t\t\treturn _empty_scope()" in access


def test_points_ui_enforces_cascading_selection_and_clears_stale_points():
	page = (ROOT / "frontend/src/pages/UsersPage.vue").read_text(encoding="utf-8")
	assert "v-if=\"form.scope_type !== 'Network'\"" in page
	assert "item.organization === form.organization" in page
	assert "item.business_entity === form.business_entity" in page
	assert 'form.business_entity = ""' in page
	assert "form.assigned_points = []" in page
	assert "allowed.has(row.business_point)" in page
	assert "Сначала выберите партнёра и юридическое лицо." in page


def test_user_facing_access_text_uses_partner_term():
	paths = [
		ROOT / "frontend/src/pages/UsersPage.vue",
		ROOT / "raspechatka/api/users.py",
		ROOT / "raspechatka/access.py",
		ROOT / "raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.py",
	]
	for path in paths:
		text = path.read_text(encoding="utf-8").casefold()
		assert "франчайзи" not in text
