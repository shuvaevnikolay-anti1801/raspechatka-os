import frappe
from frappe.utils import now_datetime


def execute():
	if not frappe.db.table_exists("MoySklad Stock Import Batch") or not frappe.db.has_column(
		"Stock Ledger Entry", "import_batch"
	):
		return
	if frappe.db.exists("MoySklad Stock Import Batch", {"mode": "Legacy"}):
		return

	conditions = """
		(sle.voucher_type = 'Stock Inventory' and exists (
			select 1 from `tabStock Inventory` d where d.name = sle.voucher_no
			and d.source = 'MoySklad Opening Balance'
		)) or
		(sle.voucher_type = 'Stock Receipt' and exists (
			select 1 from `tabStock Receipt` d where d.name = sle.voucher_no and d.source = 'MoySklad'
		)) or
		(sle.voucher_type = 'Stock Write Off' and exists (
			select 1 from `tabStock Write Off` d where d.name = sle.voucher_no and d.source = 'MoySklad'
		)) or
		(sle.voucher_type = 'Sales Receipt' and exists (
			select 1 from `tabSales Receipt` d where d.name = sle.voucher_no
			and d.source = 'MoySklad' and d.posting_datetime >= '2026-07-01 00:00:00'
		))
	"""
	count = frappe.db.sql(
		f"select count(*) from `tabStock Ledger Entry` sle where coalesce(sle.import_batch, '') = '' and ({conditions})"
	)[0][0]
	if not count:
		return

	batch = frappe.get_doc(
		{
			"doctype": "MoySklad Stock Import Batch",
			"status": "Active",
			"mode": "Legacy",
			"history_from": "2026-07-01",
			"started_at": now_datetime(),
			"completed_at": now_datetime(),
			"statistics_json": frappe.as_json({"legacy_movements": count}),
		}
	).insert(ignore_permissions=True)
	frappe.db.sql(
		f"update `tabStock Ledger Entry` sle set sle.import_batch = %s where coalesce(sle.import_batch, '') = '' and ({conditions})",
		batch.name,
	)
