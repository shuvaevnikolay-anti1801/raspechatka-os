from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint

from raspechatka.access import require_access
from raspechatka.access_contract import access_contract
from raspechatka.scope import point_filter


AREA = "page.warehouse.internal_orders"
STATUS_OPTIONS = ("Новая", "В работе", "Заказана", "Закрыта", "Отклонена")
DEFAULT_PAGE_LENGTH = 50
MAX_PAGE_LENGTH = 200


def _page_args(start=0, page_length=DEFAULT_PAGE_LENGTH):
	start = max(cint(start), 0)
	page_length = min(max(cint(page_length) or DEFAULT_PAGE_LENGTH, 1), MAX_PAGE_LENGTH)
	return start, page_length


def _batch_labels(rows):
	point_ids = sorted({row.business_point for row in rows if row.business_point})
	employee_ids = sorted({row.requested_by_employee for row in rows if row.requested_by_employee})

	points = (
		frappe.get_all(
			"Business Point",
			filters={"name": ["in", point_ids]},
			fields=["name", "point_name"],
			limit_page_length=0,
		)
		if point_ids
		else []
	)
	employees = (
		frappe.get_all(
			"Employee",
			filters={"name": ["in", employee_ids]},
			fields=["name", "employee_name"],
			limit_page_length=0,
		)
		if employee_ids
		else []
	)
	return (
		{row.name: row.point_name or row.name for row in points},
		{row.name: row.employee_name or row.name for row in employees},
	)


def _get_internal_orders(search=None, status=None, business_point=None, start=0, page_length=DEFAULT_PAGE_LENGTH):
	start, page_length = _page_args(start, page_length)
	filters = point_filter(requested=business_point)
	status = str(status or "").strip()
	if status:
		if status not in STATUS_OPTIONS:
			frappe.throw(_("Неизвестный статус внутреннего заказа"))
		filters["status"] = status

	search = str(search or "").strip()
	or_filters = None
	if search:
		value = f"%{search}%"
		or_filters = {
			"name": ["like", value],
			"item_name": ["like", value],
			"comment": ["like", value],
		}

	rows = frappe.get_all(
		"Point Supply Request",
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name",
			"request_date",
			"creation",
			"business_point",
			"requested_by_employee",
			"item",
			"item_name",
			"quantity",
			"comment",
			"status",
		],
		order_by="creation desc",
		limit_start=start,
		limit_page_length=page_length + 1,
	)
	has_more = len(rows) > page_length
	rows = rows[:page_length]
	point_labels, employee_labels = _batch_labels(rows)

	return {
		"rows": [
			{
				"name": row.name,
				"request_date": str(row.request_date) if row.request_date else None,
				"creation": str(row.creation) if row.creation else None,
				"business_point": row.business_point,
				"business_point_label": point_labels.get(row.business_point, row.business_point),
				"requested_by_employee": row.requested_by_employee,
				"requested_by_employee_label": employee_labels.get(
					row.requested_by_employee, row.requested_by_employee
				),
				"item": row.item,
				"item_name": row.item_name,
				"quantity": row.quantity,
				"comment": row.comment,
				"status": row.status,
			}
			for row in rows
		],
		"start": start,
		"page_length": page_length,
		"has_more": has_more,
	}


@frappe.whitelist()
@access_contract(area=AREA, action="read", scope="point")
def get_internal_orders(search=None, status=None, business_point=None, start=0, page_length=DEFAULT_PAGE_LENGTH):
	"""Read point-scoped internal orders backed by Point Supply Request."""
	require_access(AREA, "read")
	return _get_internal_orders(search, status, business_point, start, page_length)


def _get_internal_order_options():
	points = frappe.get_all(
		"Business Point",
		filters=point_filter(field="name"),
		fields=["name", "point_name"],
		order_by="point_name asc",
		limit_page_length=0,
	)
	return {
		"points": [
			{"value": row.name, "label": row.point_name or row.name}
			for row in points
		],
		"statuses": [{"value": value, "label": value} for value in STATUS_OPTIONS],
	}


@frappe.whitelist()
@access_contract(area=AREA, action="read", scope="point")
def get_internal_order_options():
	"""Return only points visible to the current page scope plus canonical statuses."""
	require_access(AREA, "read")
	return _get_internal_order_options()
