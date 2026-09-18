"""Retired Google-to-OS club bridge.

Historical shadow DocTypes and fields remain in the database for audit and
compatibility, but Google is no longer an accepted source of Client changes.
"""

import frappe

from raspechatka.access_contract import access_contract


@frappe.whitelist(allow_guest=True, methods=["POST"])
@access_contract(auth="webhook", scope="provider")
def receive(payload=None, timestamp=None, signature=None):
	"""Reject every legacy delivery without reading or mutating club data."""
	frappe.local.response.http_status_code = 410
	return {"ok": False, "error": "GOOGLE_TO_OS_RETIRED"}
