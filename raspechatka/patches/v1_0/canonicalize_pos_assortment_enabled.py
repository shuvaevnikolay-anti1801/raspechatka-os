"""Make ``enabled`` the canonical point-of-sale assortment state.

Historically POS required both ``enabled`` and ``visible_in_pos``.  Preserving
that effective state during migration avoids exposing an item that was hidden
by either legacy switch.  The legacy column is retained and mirrored for old
clients, but no longer read as an independent business flag.
"""

import frappe


def execute():
	if not frappe.db.table_exists("Catalog Assortment"):
		return
	# Idempotent and conservative: current POS sale state was enabled AND visible.
	frappe.db.sql(
		"""
		UPDATE `tabCatalog Assortment`
		SET enabled = IF(enabled = 1 AND visible_in_pos = 1, 1, 0),
			visible_in_pos = IF(enabled = 1 AND visible_in_pos = 1, 1, 0)
		WHERE COALESCE(enabled, 0) <> COALESCE(visible_in_pos, 0)
		"""
	)
