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


def test_pos_cashier_list_uses_employee_pos_access_and_work_point_assignment():
	source = (ROOT / "raspechatka/api/pos_device.py").read_text(encoding="utf-8")
	section = source[source.index("def _point_employees") : source.index("def _customers")]
	assert '"Employee Point Assignment"' in section
	assert '"business_point": point_name' in section
	assert '"Employee"' in section
	assert '"active": 1' in section
	assert '"pos_access_enabled": 1' in section
	assert '"Raspechatka User Profile"' not in section
	assert '"Raspechatka User Point"' not in section
	assert '"User"' not in section


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


def test_open_shift_must_close_before_pos_access_or_assignment_revocation():
	team = (ROOT / "raspechatka/api/team.py").read_text(encoding="utf-8")
	assert "previous_pos_access" in team and "pos_access_revoked" in team
	assert "previous_points" in team and "removed_points" in team
	assert 'open_shift_filters = {"cashier": name, "status": "Open"}' in team
	assert "Сначала закройте открытую смену кассира" in team


def test_web_user_flows_do_not_offer_new_cashier_role():
	users = (ROOT / "raspechatka/api/users.py").read_text(encoding="utf-8")
	team = (ROOT / "raspechatka/api/team.py").read_text(encoding="utf-8")
	employees = (ROOT / "frontend/src/pages/EmployeesPage.vue").read_text(encoding="utf-8")
	assert 'if role["name"] != CASHIER_ROLE' in users
	assert "Роль кассира не создаётся как пользователь ОС" in users
	assert 'access_profile in ("Cashier", CASHIER_ROLE)' in team
	assert "Доступ к Windows-кассе" in employees
	assert 'access_profile: "Point Manager"' in employees


def test_pos_access_backfill_is_registered_and_preserves_legacy_accounts():
	patches = (ROOT / "raspechatka/patches.txt").read_text(encoding="utf-8")
	patch = (ROOT / "raspechatka/patches/v1_0/backfill_employee_pos_access.py").read_text(encoding="utf-8")
	assert "raspechatka.patches.v1_0.backfill_employee_pos_access" in patches
	assert 'CASHIER_ROLE = "Raspechatka Cashier"' in patch
	assert '"active": 1' in patch
	assert '"enabled": 1' in patch
	assert '"pos_access_enabled", 1' in patch
	assert "delete" not in patch.lower()
