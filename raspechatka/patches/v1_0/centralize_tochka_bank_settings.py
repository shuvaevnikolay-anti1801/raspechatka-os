import frappe


ROLE = "Finance Bank Manager"
SETTINGS = "Tochka Bank Settings"


def execute():
	if not frappe.db.exists("Role", ROLE):
		frappe.get_doc({"doctype": "Role", "role_name": ROLE}).insert(ignore_permissions=True)
	if not frappe.db.exists("DocType", SETTINGS):
		return
	settings = frappe.get_single(SETTINGS)
	for name in frappe.get_all("Bank Connection", pluck="name"):
		connection = frappe.get_doc("Bank Connection", name)
		if not settings.get_password("client_id"):
			client_id = connection.get_password("client_id")
			if client_id:
				settings.client_id = client_id
		if not settings.get_password("client_secret"):
			secret = connection.get_password("client_secret")
			if secret:
				settings.client_secret = secret
		# The application credentials are now stored only once, centrally.
		connection.client_id = None
		connection.client_secret = None
		connection.save(ignore_permissions=True)
	settings.callback_url = frappe.utils.get_url("/api/method/raspechatka.api.tochka.oauth_callback")
	settings.save(ignore_permissions=True)
