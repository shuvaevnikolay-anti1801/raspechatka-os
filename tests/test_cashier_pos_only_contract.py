from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_cashier_web_access_is_denied_before_routing():
	security = (ROOT / "raspechatka/security.py").read_text(encoding="utf-8")
	hooks = (ROOT / "raspechatka/hooks.py").read_text(encoding="utf-8")
	web = (ROOT / "raspechatka/www/raspechatka.py").read_text(encoding="utf-8")
	assert 'before_request = ["raspechatka.security.enforce_cashier_pos_only"]' in hooks
	assert 'CASHIER_ROLE = "Raspechatka Cashier"' in security
	assert 'NETWORK_ADMIN_ROLE = "Raspechatka Network Admin"' in security
	assert "SYSTEM_WORK_ROLES = frozenset" in security
	assert "def is_cashier_pos_only(user)" in security
	assert '"access_profile": CASHIER_ROLE' in security
	assert '"active": 1' in security and '"linked_employee"' in security
	assert "frappe.PermissionError" in security
	assert '"raspechatka.api.pos_v2.get_bootstrap"' in security
	assert '"raspechatka.api.pos_v2.push_events"' in security
	assert '"raspechatka.api.receipt_search.search_receipts"' in security
	assert '"raspechatka.api.pos.get_bootstrap"' not in security
	assert '"raspechatka.api.pos.push_events"' not in security
	assert "is_cashier_pos_only(frappe.session.user)" in web and "frappe.PermissionError" in web


def test_pos_cashier_list_requires_active_cashier_profile_user_and_profile_point_scope():
	source = (ROOT / "raspechatka/api/pos_device.py").read_text(encoding="utf-8")
	section = source[source.index("def _point_employees") : source.index("def _customers")]
	assert '"Raspechatka User Profile"' in section
	assert '"access_profile": "Raspechatka Cashier"' in section
	assert '"active": 1' in section
	assert '"User"' in section and '"enabled": 1' in section
	assert '"Raspechatka User Point"' in section
	assert '"business_point": point_name' in section
	assert 'profile.scope_type == "Points"' in section
	assert 'profile.scope_type == "Business Entity"' in section
	assert 'profile.scope_type == "Partner"' in section
	assert '"Employee Point Assignment"' not in section


def test_cashier_profile_requires_active_employee_link():
	profile = (
		ROOT / "raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.py"
	).read_text(encoding="utf-8")
	schema = (
		ROOT / "raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.json"
	).read_text(encoding="utf-8")
	assert "def _validate_employee_link" in profile
	assert 'self.access_profile == "Raspechatka Cashier" and not self.linked_employee' in profile
	assert "Для роли «Кассир» выберите связанного сотрудника" in profile
	assert "Связанный сотрудник должен быть активным" in profile
	assert '"mandatory_depends_on": "eval:doc.access_profile==\'Raspechatka Cashier\'"' in schema


def test_pos_rejects_cross_point_cashier_filters_and_unknown_selection():
	receipts = (ROOT / "raspechatka/api/receipt_search.py").read_text(encoding="utf-8")
	device = (ROOT / "raspechatka/api/pos_device.py").read_text(encoding="utf-8")
	assert "base_pos._selected_employee(base_pos._point_employees(point), cashier_id)" in receipts
	assert "Сотрудник не прикреплён к этой точке" in device
	assert "def _bootstrap_employee" in device


def test_revocation_blocks_new_pos_work_but_keeps_shift_closure_available():
	sync = (ROOT / "pos/src/main/sync.ts").read_text(encoding="utf-8")
	ipc = (ROOT / "pos/src/main/ipc.ts").read_text(encoding="utf-8")
	assert "remote.employees.some((employee)=>employee.id===config.cashierId)" in sync
	assert "accessRevoked:!selectedIsConfirmed" in sync
	assert "assertCashierAccess()" in ipc
	close_section = ipc[
		ipc.index("ipcMain.handle('pos:close-shift'") : ipc.index(
			"ipcMain.handle('pos:get-connection-status'"
		)
	]
	assert "assertCashierAccess()" not in close_section


def test_open_shift_must_close_before_access_or_assignment_revocation():
	profile = (
		ROOT / "raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.py"
	).read_text(encoding="utf-8")
	team = (ROOT / "raspechatka/api/team.py").read_text(encoding="utf-8")
	assert '"Sales Shift", {"cashier": previous.linked_employee, "status": "Open"}' in profile
	assert "Сначала закройте открытую смену кассира" in profile
	assert "previous_points" in team and "removed_points" in team
	assert 'open_shift_filters = {"cashier": name, "status": "Open"}' in team
