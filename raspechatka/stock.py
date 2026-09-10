import hashlib

import frappe
from frappe import _
from frappe.utils import flt, get_datetime, now_datetime

EPSILON = 0.000001


def validate_warehouse_header(business_entity, business_point, warehouse):
    if (
        frappe.db.get_value("Business Point", business_point, "business_entity")
        != business_entity
    ):
        frappe.throw(_("Точка продаж не относится к выбранному юридическому лицу."))
    if (
        frappe.db.get_value("Catalog Warehouse", warehouse, "business_point")
        != business_point
    ):
        frappe.throw(_("Склад не относится к выбранной точке продаж."))


def get_item(item_name, allow_inactive=False):
    item = frappe.db.get_value(
        "Catalog Item",
        item_name,
        [
            "item_code",
            "item_name",
            "item_type",
            "stock_uom",
            "track_inventory",
            "active",
        ],
        as_dict=True,
    )
    if (
        not item
        or item.item_type not in {"Product", "Variant"}
        or not item.track_inventory
        or (not item.active and not allow_inactive)
    ):
        frappe.throw(
            _(
                "В складской документ можно добавить только активный товар с учётом остатков."
            )
        )
    return item


def validate_location(storage_location, warehouse):
    if (
        storage_location
        and frappe.db.get_value("Storage Location", storage_location, "warehouse")
        != warehouse
    ):
        frappe.throw(_("Место хранения должно относиться к складу документа."))


def validate_chronology(warehouse, posting_datetime):
    latest = frappe.db.get_value(
        "Stock Ledger Entry",
        {"warehouse": warehouse},
        "posting_datetime",
        order_by="posting_datetime desc",
    )
    if latest and get_datetime(posting_datetime) < get_datetime(latest):
        frappe.throw(
            _(
                "Нельзя провести складской документ раньше уже существующего движения ({0})."
            ).format(latest)
        )


def get_balance(
    item, warehouse, storage_location=None, posting_datetime=None, lock=False
):
    conditions = ["item=%s", "warehouse=%s"]
    values = [item, warehouse]
    if storage_location is not None:
        if storage_location:
            conditions.append("storage_location=%s")
            values.append(storage_location)
        else:
            conditions.append("coalesce(storage_location, '')=''")
    if posting_datetime:
        conditions.append("posting_datetime<=%s")
        values.append(posting_datetime)
    if lock:
        _lock_balance(item, warehouse)
    if (
        storage_location is None
        and posting_datetime is None
        and frappe.db.table_exists("Stock Balance")
    ):
        current = frappe.db.get_value(
            "Stock Balance",
            _balance_key(item, warehouse),
            ["actual_qty", "stock_value"],
            as_dict=True,
        )
        if current:
            return {"qty": flt(current.actual_qty), "value": flt(current.stock_value)}
    row = frappe.db.sql(
        f"""select coalesce(sum(actual_qty), 0) as qty,
			coalesce(sum(stock_value_difference), 0) as value
		from `tabStock Ledger Entry`
		where {" and ".join(conditions)}""",
        tuple(values),
        as_dict=True,
    )[0]
    return {"qty": flt(row.qty), "value": flt(row.value)}


def get_average_rate(item, warehouse, posting_datetime=None):
    balance = get_balance(item, warehouse, posting_datetime=posting_datetime)
    return flt(balance["value"] / balance["qty"]) if balance["qty"] else 0


def make_ledger_entry(
    document, row, quantity, rate, amount, reversal=False, valuation_source=None
):
    """Post exactly one immutable stock movement.

    All callers use this service so idempotency, locking and chronology are
    enforced in one transaction. Actual stock is allowed to become negative.
    """
    quantity = -flt(quantity) if reversal else flt(quantity)
    amount = -flt(amount) if reversal else flt(amount)
    if abs(quantity) <= EPSILON:
        return None

    posting_datetime = now_datetime() if reversal else document.posting_datetime
    movement_key = _movement_key(document.doctype, document.name, row.name, reversal)
    existing = frappe.db.get_value(
        "Stock Ledger Entry", {"movement_key": movement_key}, "name"
    )
    if existing:
        return frappe.get_doc("Stock Ledger Entry", existing)

    warehouse = document.warehouse
    validate_location(getattr(row, "storage_location", None), warehouse)
    warehouse_balance = get_balance(row.item, warehouse, lock=True)
    qty_after = flt(warehouse_balance["qty"]) + quantity
    value_after = flt(warehouse_balance["value"]) + amount
    entry = frappe.new_doc("Stock Ledger Entry")
    entry.posting_datetime = posting_datetime
    entry.item = row.item
    entry.warehouse = warehouse
    entry.storage_location = getattr(row, "storage_location", None)
    entry.actual_qty = quantity
    entry.incoming_rate = flt(rate)
    entry.stock_value_difference = amount
    entry.quantity_before = flt(warehouse_balance["qty"])
    entry.quantity_after = qty_after
    entry.stock_value_after = value_after
    entry.valuation_source = valuation_source or _default_valuation_source(
        quantity, reversal
    )
    entry.voucher_type = document.doctype
    entry.voucher_no = document.name
    entry.voucher_detail_no = row.name
    entry.movement_key = movement_key
    entry.is_reversal = 1 if reversal else 0
    entry.insert(ignore_permissions=True)
    write_operational_balance(
        row.item,
        warehouse,
        qty_after,
        value_after,
        posting_datetime,
        entry.name,
    )
    return entry


def write_operational_balance(
    item, warehouse, quantity, stock_value, last_movement_at, last_ledger_entry
):
    """Update the fast current balance inside the caller's transaction."""
    _lock_balance(item, warehouse)
    key = _balance_key(item, warehouse)
    existing = frappe.db.exists("Stock Balance", key)
    reserved = flt(
        frappe.db.get_value("Stock Balance", key, "reserved_qty") if existing else 0
    )
    values = {
        "item": item,
        "warehouse": warehouse,
        "actual_qty": flt(quantity),
        "reserved_qty": reserved,
        "available_qty": flt(quantity) - reserved,
        "stock_value": flt(stock_value),
        "average_rate": flt(stock_value / quantity) if quantity else 0,
        "last_movement_at": last_movement_at,
        "last_ledger_entry": last_ledger_entry,
    }
    if existing:
        frappe.db.set_value("Stock Balance", key, values, update_modified=False)
        return key

    doc = frappe.new_doc("Stock Balance")
    doc.balance_key = key
    doc.update(values)
    doc.insert(ignore_permissions=True)
    return doc.name


def _balance_key(item, warehouse):
    return hashlib.sha256(f"{item}|{warehouse}".encode()).hexdigest()


def _lock_balance(item, warehouse):
    """Serialize movements for an item/warehouse pair.

    The item row always exists and gives us a lock even before the first ledger
    entry, avoiding the empty-result race of locking only the ledger table.
    """
    frappe.db.sql("select name from `tabCatalog Item` where name=%s for update", item)
    frappe.db.sql(
        "select name from `tabCatalog Warehouse` where name=%s for update", warehouse
    )


def _movement_key(voucher_type, voucher_no, voucher_detail_no, reversal):
    raw = "|".join(
        [
            str(voucher_type or ""),
            str(voucher_no or ""),
            str(voucher_detail_no or ""),
            "reversal" if reversal else "posting",
        ]
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def _default_valuation_source(quantity, reversal):
    if reversal:
        return "Reversal"
    return "Incoming document rate" if quantity > 0 else "Warehouse weighted average"
