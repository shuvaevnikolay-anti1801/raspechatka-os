import frappe
from frappe.model.naming import make_autoname
from frappe.utils import now_datetime

from raspechatka.raspechatka_os.doctype.client.client import normalize_phone


AREAS = (
	("clients.base", "Клиенты и история покупок", "/clients", 42),
	("clients.loyalty", "Клуб Распечатка и скидки", "/clients/club", 43),
	("clients.marketing", "Сегменты, рассылки и промо", "/clients/segments", 44),
)

LEVELS = {
	"Raspechatka Network Admin": ("Admin", "Admin", "Admin"),
	"Raspechatka Franchise Owner": ("Edit", "View", "View"),
	"Raspechatka Point Manager": ("Edit", "View", "View"),
	"Raspechatka Cashier": ("Edit", "View", "None"),
}


def execute():
	_create_access_areas()
	_create_settings()
	_upgrade_clients()


def _create_access_areas():
	for code, label, route, order in AREAS:
		if not frappe.db.exists("Access Area", code):
			frappe.get_doc({"doctype": "Access Area", "area_code": code, "area_name": label, "route": route, "sort_order": order, "active": 1, "system_area": 1}).insert(ignore_permissions=True)
	doc = frappe.get_single("Raspechatka Access Settings")
	existing = {(row.role, row.access_area) for row in doc.rules}
	for role, levels in LEVELS.items():
		for area, level in zip(AREAS, levels):
			if (role, area[0]) not in existing:
				doc.append("rules", {"role": role, "access_area": area[0], "access_level": level})
	doc.save(ignore_permissions=True)


def _create_settings():
	doc = frappe.get_single("Loyalty Settings")
	doc.club_name = doc.club_name or "Клуб Распечатка"
	doc.active = 1
	doc.max_active_channels = doc.max_active_channels or 2
	doc.maximum_discount_percent = doc.maximum_discount_percent or 5
	doc.personal_data_required = 1
	doc.marketing_required = 1
	doc.club_rules_required = 1
	doc.personal_data_version = doc.personal_data_version or "1.0"
	doc.marketing_version = doc.marketing_version or "1.0"
	doc.club_rules_version = doc.club_rules_version or "1.0"
	doc.session_lifetime_days = doc.session_lifetime_days or 7
	if not doc.discount_rules:
		for count, discount in ((0, 0), (1, 3), (2, 5)):
			doc.append("discount_rules", {"active_channel_count": count, "discount_percent": discount, "active": 1})
	doc.save(ignore_permissions=True)


def _upgrade_clients():
	for row in frappe.get_all("Client", fields=["name", "client_id", "phone", "personal_data_consent", "marketing_consent", "personal_data_consent_at", "marketing_consent_at"]):
		values = {}
		if not row.client_id:
			values["client_id"] = make_autoname("RP-.######")
		phone = normalize_phone(row.phone)
		if phone and phone != row.phone and not frappe.db.exists("Client", {"phone": phone, "name": ["!=", row.name]}):
			values["phone"] = phone
		if values:
			frappe.db.set_value("Client", row.name, values, update_modified=False)
		for flag, consent_type, timestamp in (
			(row.personal_data_consent, "Персональные данные", row.personal_data_consent_at),
			(row.marketing_consent, "Рекламные сообщения", row.marketing_consent_at),
		):
			if flag and not frappe.db.exists("Client Consent", {"client": row.name, "consent_type": consent_type}):
				frappe.get_doc({"doctype": "Client Consent", "client": row.name, "consent_type": consent_type, "accepted": 1, "recorded_at": timestamp or now_datetime(), "document_version": "legacy", "source": "Перенос из справочника"}).insert(ignore_permissions=True)
