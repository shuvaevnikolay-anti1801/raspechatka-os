import frappe


def execute():
	"""Resume the idempotent one-time import after adding resilient API reads."""
	settings = frappe.get_single("MoySklad Settings")
	if not settings.get_password("access_token", raise_exception=False):
		return
	if settings.catalog_sync_status in ("Queued", "Running"):
		return

	settings.catalog_sync_status = "Queued"
	settings.catalog_sync_error = None
	settings.save(ignore_permissions=True)
	frappe.enqueue(
		"raspechatka.api.moysklad.run_catalog_sync",
		queue="long",
		job_name="raspechatka-moysklad-catalog-import-resume",
		timeout=7200,
		enqueue_after_commit=True,
	)
