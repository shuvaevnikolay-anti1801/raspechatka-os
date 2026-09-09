# ruff: noqa: RUF001
from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

from raspechatka.access import get_scope, require_access


@frappe.whitelist()
def get_payment_context(order_name):
	require_access("page.warehouse.purchase_orders", "read")
	order = _get_order(order_name)
	return _payment_context(order)


@frappe.whitelist(methods=["POST"])
def link_payment(order_name, payment_name, allocated_amount):
	require_access("page.warehouse.purchase_orders", "write")
	order = _get_order(order_name)
	if order.docstatus != 1:
		frappe.throw(_("Оплаты можно связывать только с проведённым заказом."))

	frappe.db.sql(
		"select name from `tabPurchase Order` where name = %s for update",
		(order.name,),
	)
	frappe.db.sql(
		"select name from `tabFinance Transaction` where name = %s for update",
		(payment_name,),
	)
	existing = frappe.db.get_value(
		"Supplier Payment Allocation",
		{"purchase_order": order.name, "finance_transaction": payment_name},
		"name",
	)
	if existing:
		return _payment_context(order)

	allocation = frappe.get_doc(
		{
			"doctype": "Supplier Payment Allocation",
			"purchase_order": order.name,
			"finance_transaction": payment_name,
			"allocated_amount": flt(allocated_amount),
		}
	)
	allocation.insert(ignore_permissions=True)
	order.reload()
	return _payment_context(order)


@frappe.whitelist(methods=["POST"])
def unlink_payment(order_name, allocation_name):
	require_access("page.warehouse.purchase_orders", "write")
	order = _get_order(order_name)
	if not frappe.db.exists(
		"Supplier Payment Allocation",
		{"name": allocation_name, "purchase_order": order.name},
	):
		frappe.throw(_("Связь оплаты не найдена."))
	frappe.delete_doc(
		"Supplier Payment Allocation",
		allocation_name,
		ignore_permissions=True,
	)
	order.reload()
	return _payment_context(order)


@frappe.whitelist()
def get_supplier_debt(
	from_date=None,
	to_date=None,
	business_entity=None,
	business_point=None,
	search=None,
):
	require_access("page.finance.settlements", "read")
	filters = {"docstatus": 1}
	filters.update(_scope_filters(business_entity, business_point))
	if from_date and to_date:
		filters["order_date"] = ["between", [from_date, to_date]]
	elif from_date:
		filters["order_date"] = [">=", from_date]
	elif to_date:
		filters["order_date"] = ["<=", to_date]

	orders = frappe.get_all(
		"Purchase Order",
		filters=filters,
		fields=[
			"name",
			"supplier",
			"total_amount",
			"paid_amount",
			"outstanding_amount",
			"payment_due_date",
		],
		limit_page_length=0,
	)
	supplier_names = {
		row.name: row.supplier_name
		for row in frappe.get_all(
			"Catalog Supplier",
			filters={"name": ["in", list({row.supplier for row in orders}) or ["__none__"]]},
			fields=["name", "supplier_name"],
			limit_page_length=0,
		)
	}
	query = (search or "").strip().lower()
	today = getdate(nowdate())
	result = {}
	for order in orders:
		supplier_name = supplier_names.get(order.supplier) or order.supplier
		if query and query not in supplier_name.lower():
			continue
		bucket = result.setdefault(
			order.supplier,
			{
				"supplier": order.supplier,
				"supplier_name": supplier_name,
				"orders_count": 0,
				"order_total": 0.0,
				"paid_amount": 0.0,
				"outstanding_amount": 0.0,
				"overdue_amount": 0.0,
				"nearest_due_date": None,
			},
		)
		outstanding = flt(order.outstanding_amount)
		bucket["orders_count"] += 1
		bucket["order_total"] += flt(order.total_amount)
		bucket["paid_amount"] += flt(order.paid_amount)
		bucket["outstanding_amount"] += outstanding
		if order.payment_due_date and getdate(order.payment_due_date) < today:
			bucket["overdue_amount"] += outstanding
		if outstanding and order.payment_due_date:
			due_date = getdate(order.payment_due_date)
			if not bucket["nearest_due_date"] or due_date < bucket["nearest_due_date"]:
				bucket["nearest_due_date"] = due_date

	rows = sorted(
		result.values(),
		key=lambda row: (-row["overdue_amount"], -row["outstanding_amount"], row["supplier_name"]),
	)
	return {
		"rows": rows,
		"totals": {
			"orders_count": sum(row["orders_count"] for row in rows),
			"order_total": sum(row["order_total"] for row in rows),
			"paid_amount": sum(row["paid_amount"] for row in rows),
			"outstanding_amount": sum(row["outstanding_amount"] for row in rows),
			"overdue_amount": sum(row["overdue_amount"] for row in rows),
		},
	}


def _get_order(order_name):
	if not order_name:
		frappe.throw(_("Укажите заказ поставщику."))
	order = frappe.get_doc("Purchase Order", order_name)
	allowed_points = _scope_points()
	if allowed_points is not None and order.business_point not in allowed_points:
		frappe.throw(_("Заказ недоступен."), frappe.PermissionError)
	return order


def _payment_context(order):
	allocations = frappe.db.sql(
		"""
		select allocation.name, allocation.finance_transaction,
			allocation.allocated_amount, payment.posting_date,
			payment.amount as payment_amount, payment.source,
			payment.purpose, payment.counterparty_name, payment.docstatus
		from `tabSupplier Payment Allocation` allocation
		join `tabFinance Transaction` payment
			on payment.name = allocation.finance_transaction
		where allocation.purchase_order = %s
		order by payment.posting_date desc, allocation.creation desc
		""",
		(order.name,),
		as_dict=True,
	)
	payments = frappe.get_all(
		"Finance Transaction",
		filters={
			"docstatus": 1,
			"status": "Posted",
			"direction": "Expense",
			"business_entity": order.business_entity,
			"supplier": order.supplier,
		},
		fields=[
			"name",
			"posting_date",
			"amount",
			"source",
			"purpose",
			"counterparty_name",
		],
		order_by="posting_date desc, creation desc",
		limit_page_length=500,
	)
	allocated_by_payment = {}
	for allocation in frappe.get_all(
		"Supplier Payment Allocation",
		filters={
			"finance_transaction": [
				"in",
				[row.name for row in payments] or ["__none__"],
			]
		},
		fields=["finance_transaction", "allocated_amount"],
		limit_page_length=0,
	):
		allocated_by_payment[allocation.finance_transaction] = (
			allocated_by_payment.get(allocation.finance_transaction, 0)
			+ flt(allocation.allocated_amount)
		)
	available = []
	for payment in payments:
		payment["available_amount"] = max(
			flt(payment.amount) - allocated_by_payment.get(payment.name, 0),
			0,
		)
		if payment.available_amount:
			available.append(payment)
	return {
		"allocations": allocations,
		"available_payments": available,
		"paid_amount": flt(order.paid_amount),
		"outstanding_amount": flt(order.outstanding_amount),
		"payment_status": order.payment_status,
	}


def _scope_points():
	scope = get_scope()
	return None if scope["global"] else set(scope["points"] or [])


def _scope_filters(business_entity=None, business_point=None):
	scope = get_scope()
	filters = {}
	if not scope["global"]:
		entities = scope.get("business_entities") or (
			[scope.get("business_entity")] if scope.get("business_entity") else []
		)
		if business_entity and business_entity not in entities:
			frappe.throw(_("Юридическое лицо недоступно."), frappe.PermissionError)
		filters["business_entity"] = (
			business_entity if business_entity else ["in", entities or ["__none__"]]
		)
		if business_point and business_point not in (scope["points"] or []):
			frappe.throw(_("Точка продаж недоступна."), frappe.PermissionError)
		filters["business_point"] = (
			business_point
			if business_point
			else ["in", scope["points"] or ["__none__"]]
		)
	else:
		if business_entity:
			filters["business_entity"] = business_entity
		if business_point:
			filters["business_point"] = business_point
	return filters
