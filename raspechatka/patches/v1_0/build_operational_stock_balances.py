import frappe

from raspechatka.stock_reconciliation import rebuild_operational_balances


def execute():
    frappe.db.add_index(
        "Stock Balance",
        ["warehouse", "item"],
        "warehouse_item",
    )
    frappe.db.add_index(
        "Stock Ledger Entry",
        ["warehouse", "item", "posting_datetime"],
        "warehouse_item_posting",
    )
    rebuild_operational_balances()
