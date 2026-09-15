from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_cashier_web_access_is_denied_before_routing():
	security = (ROOT / "raspechatka/security.py").read_text(encoding="utf-8")
	hooks = (ROOT / "raspechatka/hooks.py").read_text(encoding="utf-8")
	web = (ROOT / "raspechatka/www/raspechatka.py").read_text(encoding="utf-8")
	assert 'before_request = ["raspechatka.security.enforce_cashier_pos_only"]' in hooks
	assert 'CASHIER_ROLE = "Raspechatka Cashier"' in security
	assert 'frappe.PermissionError' in security
	assert '"raspechatka.api.pos.get_bootstrap"' in security
	assert '"raspechatka.api.pos.push_events"' in security
	assert '"Raspechatka Cashier"' in web and "frappe.PermissionError" in web


def test_pos_cashier_list_requires_active_cashier_profile_user_and_point_assignment():
	source = (ROOT / "raspechatka/api/pos_device.py").read_text(encoding="utf-8")
	section = source[source.index("def _point_employees") : source.index("def _customers")]
	assert '"Employee Point Assignment"' in section
	assert '"Raspechatka User Profile"' in section
	assert '"access_profile": "Raspechatka Cashier"' in section
	assert '"active": 1' in section
	assert '"User"' in section and '"enabled": 1' in section


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
	close_section = ipc[ipc.index("ipcMain.handle('pos:close-shift'") : ipc.index("ipcMain.handle('pos:get-connection-status'")]
	assert "assertCashierAccess()" not in close_section


def test_open_shift_must_close_before_access_or_assignment_revocation():
	profile = (ROOT / "raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.py").read_text(encoding="utf-8")
	team = (ROOT / "raspechatka/api/team.py").read_text(encoding="utf-8")
	assert '"Sales Shift", {"cashier": previous.linked_employee, "status": "Open"}' in profile
	assert "Сначала закройте открытую смену кассира" in profile
	assert "previous_points" in team and "removed_points" in team
	assert 'open_shift_filters = {"cashier": name, "status": "Open"}' in team
