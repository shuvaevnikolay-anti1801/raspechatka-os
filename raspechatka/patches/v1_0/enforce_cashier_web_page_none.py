from raspechatka.access import synchronize_access_pages


def execute():
	"""Idempotently normalize every Cashier Web OS page rule to None."""
	synchronize_access_pages(copy_legacy_rules=True)
