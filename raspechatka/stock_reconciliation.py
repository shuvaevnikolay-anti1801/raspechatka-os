import json

import frappe
from frappe import _
from frappe.utils import flt

from raspechatka.stock import EPSILON, _balance_key, write_operational_balance


@frappe.whitelist(methods=["POST"])
def rebuild_operational_balances():
    """Rebuild the operational register from the immutable ledger."""
    frappe.only_for("System Manager")
    rows = _ledger_totals()
    ledger_keys = set()

    for row in rows:
        key = _balance_key(row.item, row.warehouse)
        ledger_keys.add(key)
        write_operational_balance(
            row.item,
            row.warehouse,
            row.qty,
            row.value,
            row.last_movement_at,
            None,
        )

    stale = frappe.get_all(
        "Stock Balance",
        filters={"balance_key": ["not in", list(ledger_keys) or ["__none__"]]},
        pluck="name",
        limit_page_length=0,
    )
    for name in stale:
        reserved = flt(frappe.db.get_value("Stock Balance", name, "reserved_qty"))
        frappe.db.set_value(
            "Stock Balance",
            name,
            {
                "actual_qty": 0,
                "available_qty": -reserved,
                "stock_value": 0,
                "average_rate": 0,
                "last_movement_at": None,
                "last_ledger_entry": None,
            },
            update_modified=False,
        )

    return {"rebuilt": len(rows), "reset": len(stale)}


def reconcile_operational_balances():
    """Report inconsistencies without modifying stock data."""
    ledger = {
        _balance_key(row.item, row.warehouse): row
        for row in _ledger_totals()
    }
    balances = {
        row.balance_key: row
        for row in frappe.get_all(
            "Stock Balance",
            fields=[
                "balance_key",
                "item",
                "warehouse",
                "actual_qty",
                "stock_value",
                "reserved_qty",
                "available_qty",
            ],
            limit_page_length=0,
        )
    }
    issues = []

    for key in sorted(set(ledger) | set(balances)):
        source = ledger.get(key)
        balance = balances.get(key)
        ledger_qty = flt(source.qty) if source else 0
        ledger_value = flt(source.value) if source else 0
        balance_qty = flt(balance.actual_qty) if balance else 0
        balance_value = flt(balance.stock_value) if balance else 0
        item = source.item if source else balance.item
        warehouse = source.warehouse if source else balance.warehouse

        if abs(ledger_qty - balance_qty) > EPSILON or abs(ledger_value - balance_value) > EPSILON:
            issues.append(
                {
                    "type": "balance_mismatch",
                    "item": item,
                    "warehouse": warehouse,
                    "ledger_qty": ledger_qty,
                    "balance_qty": balance_qty,
                    "ledger_value": ledger_value,
                    "balance_value": balance_value,
                }
            )
        if ledger_qty < -EPSILON:
            issues.append({"type": "negative_stock", "item": item, "warehouse": warehouse, "quantity": ledger_qty})
        if ledger_qty > EPSILON and abs(ledger_value) <= EPSILON:
            issues.append({"type": "positive_stock_without_value", "item": item, "warehouse": warehouse, "quantity": ledger_qty})
        if balance and abs(flt(balance.available_qty) - (balance_qty - flt(balance.reserved_qty))) > EPSILON:
            issues.append({"type": "available_quantity_mismatch", "item": item, "warehouse": warehouse})

    duplicates = frappe.db.sql(
        """select movement_key, count(*) as occurrences
        from `tabStock Ledger Entry`
        where coalesce(movement_key, '') != ''
        group by movement_key
        having count(*) > 1""",
        as_dict=True,
    )
    for row in duplicates:
        issues.append(
            {
                "type": "duplicate_movement",
                "movement_key": row.movement_key,
                "occurrences": row.occurrences,
            }
        )

    if issues:
        frappe.log_error(
            title=_("Обнаружены расхождения складских остатков"),
            message=json.dumps(issues[:200], ensure_ascii=False, indent=2, default=str),
        )
    return {"ok": not issues, "issue_count": len(issues), "issues": issues[:200]}


def _ledger_totals():
    return frappe.db.sql(
        """select item, warehouse,
            coalesce(sum(actual_qty), 0) as qty,
            coalesce(sum(stock_value_difference), 0) as value,
            max(posting_datetime) as last_movement_at
        from `tabStock Ledger Entry`
        group by item, warehouse""",
        as_dict=True,
    )
