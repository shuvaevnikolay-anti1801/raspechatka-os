import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, nowdate

from raspechatka.stock import get_item, validate_warehouse_header


class PurchaseOrder(Document):
	def before_insert(self):
		self.order_date = self.order_date or nowdate()

	def validate(self):
		validate_warehouse_header(self.business_entity, self.business_point, self.warehouse)
		if not frappe.db.exists("Catalog Supplier", {"name": self.supplier, "active": 1}):
			frappe.throw(_("Выберите активного поставщика."))
		if self.expected_date and self.expected_date < self.order_date:
			frappe.throw(_("Ожидаемая дата не может быть раньше даты заказа."))
		if not self.items:
			frappe.throw(_("Добавьте хотя бы один товар."))
		seen = set()
		for row in self.items:
			item = get_item(row.item)
			if row.item in seen:
				frappe.throw(_("Товар {0} указан в заказе дважды.").format(item.item_name))
			seen.add(row.item)
			row.item_code, row.uom = item.item_code, row.uom or item.stock_uom
			if flt(row.quantity) <= 0 or flt(row.rate) <= 0:
				frappe.throw(_("Количество и закупочная цена должны быть больше нуля."))
			row.amount = flt(row.quantity) * flt(row.rate)
		self.total_quantity = sum(flt(row.quantity) for row in self.items)
		self.received_quantity = sum(flt(row.received_quantity) for row in self.items)
		self.total_amount = sum(flt(row.amount) for row in self.items)

	def on_submit(self):
		self.db_set("order_status", "Ожидается", update_modified=False)


def update_received_quantities(order_name):
	if not frappe.db.exists("Purchase Order", order_name):
		return
	order = frappe.get_doc("Purchase Order", order_name)
	receipts = frappe.get_all("Stock Receipt", filters={"purchase_order": order_name, "docstatus": 1}, pluck="name")
	received = {}
	if receipts:
		for row in frappe.get_all("Stock Receipt Item", filters={"parent": ["in", receipts]}, fields=["purchase_order_item", "quantity"], limit_page_length=100000):
			if row.purchase_order_item:
				received[row.purchase_order_item] = received.get(row.purchase_order_item, 0) + flt(row.quantity)
	total = 0
	for row in order.items:
		row.db_set("received_quantity", received.get(row.name, 0), update_modified=False)
		total += received.get(row.name, 0)
	status = "Принято" if order.total_quantity and total >= flt(order.total_quantity) else "Частично принято" if total else "Ожидается"
	frappe.db.set_value("Purchase Order", order_name, {"received_quantity": total, "order_status": status}, update_modified=False)
