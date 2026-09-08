"""Additive, idempotent legacy identifiers; never imports customer data on migrate."""

from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
	fields = {
		"Client": [
			{"fieldname": "legacy_club_id", "label": "ID старого клуба", "fieldtype": "Data", "unique": 1},
			{"fieldname": "legacy_club_hash", "label": "Хеш источника", "fieldtype": "Data", "hidden": 1},
			{
				"fieldname": "legacy_club_revision",
				"label": "Версия источника",
				"fieldtype": "Data",
				"hidden": 1,
			},
			{"fieldname": "legacy_club_synced_at", "label": "Синхронизация клуба", "fieldtype": "Datetime"},
			{"fieldname": "legacy_club_discount", "label": "Скидка в источнике", "fieldtype": "Percent"},
			{"fieldname": "legacy_moysklad_id", "label": "ID клиента МойСклад (клуб)", "fieldtype": "Data"},
			{
				"fieldname": "legacy_moysklad_status",
				"label": "Обмен МойСклад (источник)",
				"fieldtype": "Small Text",
			},
		],
		"Client Messenger": [
			{"fieldname": "legacy_channel_id", "label": "ID канала источника", "fieldtype": "Data"},
		],
		"Client Consent": [
			{
				"fieldname": "legacy_consent_key",
				"label": "Ключ согласия источника",
				"fieldtype": "Data",
				"unique": 1,
			},
		],
		"Client Event Log": [
			{
				"fieldname": "legacy_event_key",
				"label": "Ключ события источника",
				"fieldtype": "Data",
				"unique": 1,
			},
		],
	}
	for rows in fields.values():
		for row in rows:
			row.update({"read_only": 1, "no_copy": 1})
	create_custom_fields(fields, update=True)
