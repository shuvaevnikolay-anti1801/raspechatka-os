from raspechatka.raspechatka_os.doctype.client.client import sync_client_id_series


def execute():
	"""Repair a stale RP- naming series after legacy or manual client imports."""
	sync_client_id_series()
