from raspechatka.access import synchronize_access_pages


def execute():
	synchronize_access_pages(copy_legacy_rules=True)
