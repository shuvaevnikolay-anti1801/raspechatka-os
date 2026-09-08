"""Read-only mirror of the running club. Does not call MoySklad or BotHelp."""

import json
import re
import time

import frappe
from frappe.utils import get_datetime, now_datetime

from raspechatka.access import get_scope, require_access
from raspechatka.club_sync_protocol import digest, identifier, truth, verify
from raspechatka.raspechatka_os.doctype.client.client import normalize_phone


def _admin():
	require_access("clients.loyalty", "admin")
	if not get_scope().get("global"):
		frappe.throw("Настройка доступна только администратору сети", frappe.PermissionError)


def _settings():
	return frappe.get_single("Club Shadow Settings")


def _validate_point(point):
	row = frappe.db.get_value("Business Point", point, ["city", "address", "active"], as_dict=True)
	if not row or not row.active:
		raise ValueError("POINT_NOT_FOUND")
	city = str(row.city).lower().replace("ё", "е")
	address = str(row.address).lower().replace("ё", "е")
	if "ярославль" not in city or "комсомольск" not in address or not re.search(r"(?<!\d)12(?!\d)", address):
		raise ValueError("EXPECTED_YAROSLAVL_KOMSOMOLSKAYA_12")
	return point


@frappe.whitelist()
def status():
	_admin()
	s = _settings()
	return {
		"enabled": bool(s.enabled), "business_point": s.business_point,
		"source_id": s.source_id, "secret_configured": bool(s.get_password("shared_secret", raise_exception=False)),
		"clients": frappe.db.count("Client", {"legacy_club_id": ["is", "set"]}),
		"last_received_at": s.last_received_at,
		"recent": frappe.get_all("Club Sync Receipt", fields=["name", "outcome", "received_at"], order_by="received_at desc", limit_page_length=20),
		"points": frappe.get_all("Business Point", filters={"active": 1}, fields=["name", "point_name", "city", "address"]),
	}


@frappe.whitelist(methods=["POST"])
def configure(data):
	_admin()
	data = frappe.parse_json(data)
	s = _settings()
	s.business_point = _validate_point(data.get("business_point"))
	s.source_id = identifier(data.get("source_id"))
	if not s.source_id:
		raise ValueError("SOURCE_ID_REQUIRED")
	if data.get("shared_secret"):
		if len(data["shared_secret"]) < 32:
			raise ValueError("SECRET_MINIMUM_32_CHARACTERS")
		s.shared_secret = data["shared_secret"]
	s.enabled = int(truth(data.get("enabled")))
	if s.enabled and not (data.get("shared_secret") or s.get_password("shared_secret", raise_exception=False)):
		raise ValueError("SECRET_REQUIRED")
	s.save(ignore_permissions=True)
	return {"saved": True}


def _date(value):
	if not value:
		return None
	# GAS exports local wall clock in the site's timezone, not browser timezone.
	return get_datetime(value)


def _audit(client, rows, kind):
	is_consent = kind == "consents"
	doctype = "Client Consent" if is_consent else "Client Event Log"
	keyfield = "legacy_consent_key" if is_consent else "legacy_event_key"
	for row in rows:
		id_key = "Consent ID" if is_consent else "Event ID"
		external = identifier(row.get(id_key))
		if not external:
			raise ValueError("AUDIT_ID_REQUIRED")
		key = digest(kind + ":" + client.client_id + ":" + external + ":" + str(row.get("Дата отзыва") or ""))
		if frappe.db.exists(doctype, {keyfield: key}):
			continue
		common = {"doctype": doctype, "client": client.name, keyfield: key, "source": row.get("Источник") or "Google Sheets"}
		if is_consent:
			common.update({
				"consent_type": row.get("Тип согласия"), "accepted": int(truth(row.get("Согласие"))),
				"recorded_at": _date(row.get("Дата/время")), "document_version": row.get("Версия документа") or "legacy",
				"document_url": row.get("URL документа"), "submission_id": identifier(row.get("Form Submission ID")),
				"revoked_at": _date(row.get("Дата отзыва")), "ip_address": row.get("IP"), "user_agent": row.get("User-Agent"),
			})
		else:
			# Raw request bodies in the old log contain login tokens. Never import them.
			common.update({"event_datetime": _date(row.get("Дата/время")), "event_type": row.get("Событие") or "LEGACY_EVENT",
				"channel": row.get("Канал"), "status": row.get("Статус"), "external_id": external,
				"details": "Историческое событие. Исходное тело запроса не перенесено (секреты)."})
		frappe.get_doc(common).insert(ignore_permissions=True)


def _apply(data, settings):
	row = data["client"]
	legacy_id = identifier(row.get("Client ID"))
	phone = normalize_phone(row.get("Телефон"))
	if not legacy_id or not phone:
		raise ValueError("CLIENT_ID_AND_PHONE_REQUIRED")
	by_id = frappe.db.get_value("Client", {"client_id": legacy_id}, "name")
	by_phone = frappe.db.get_value("Client", {"phone": phone}, "name")
	if by_phone and by_phone != by_id:
		raise ValueError("PHONE_ID_CONFLICT")
	doc = frappe.get_doc("Client", by_id) if by_id else frappe.new_doc("Client")
	if by_id and not doc.get("legacy_club_id"):
		raise ValueError("OS_CLIENT_REQUIRES_MANUAL_MATCH")
	if int(data.get("revision") or 0) <= int(doc.get("legacy_club_revision") or 0):
		return "MATCH"
	# One source row at a time; the receiver holds a transaction row lock.
	doc.flags.club_shadow_import = True
	doc.client_id = legacy_id
	doc.legacy_club_id = legacy_id
	doc.phone = phone
	doc.first_name = str(row.get("Имя") or "Клиент").strip()
	doc.registration_point = _validate_point(settings.business_point)
	doc.registration_source = row.get("Источник") or "Исторический импорт / Клуб Распечатка"
	doc.registered_at = _date(row.get("Дата регистрации")) or doc.registered_at
	doc.active = int(row.get("Статус") != "Заблокирован")
	doc.notes = row.get("Комментарий")
	for field, source in (("personal_data_consent", "Согласие ПД"), ("marketing_consent", "Согласие на рекламу"), ("club_rules_consent", "Правила клуба")):
		doc.set(field, int(truth(row.get(source))))
	for field, source in (("link_token", "Link Token"), ("session_token", "Session Token")):
		doc.set(field, identifier(row.get(source)) or None)
	doc.session_created = _date(row.get("Session Created"))
	doc.session_expires = _date(row.get("Session Expires"))
	doc.legacy_moysklad_id = identifier(row.get("ID контрагента МойСклад"))
	doc.legacy_moysklad_status = row.get("Синхронизация МойСклад")
	doc.legacy_club_discount = float(row.get("Скидка, %") or 0)
	channels = data.get("channels", [])
	latest = {}
	for channel in channels:
		name = channel.get("Канал")
		if name not in ("Telegram", "MAX", "VK"):
			raise ValueError("UNKNOWN_CHANNEL")
		stamp = str(channel.get("Последняя активность") or channel.get("Дата подключения") or "")
		if name not in latest or stamp >= latest[name][0]:
			latest[name] = (stamp, channel)
	doc.set("messengers", [])
	priority = {row.get("Основной канал"): 0, row.get("Резервный канал"): 1}
	for name, (_, ch) in sorted(latest.items(), key=lambda pair: priority.get(pair[0], 2)):
		doc.append("messengers", {
			"messenger_type": name, "legacy_channel_id": identifier(ch.get("Channel Record ID")),
			"status": ch.get("Статус") or "Отключен", "platform_user_id": identifier(ch.get("Platform User ID")),
			"bothelp_subscriber_id": identifier(ch.get("BotHelp Subscriber ID")), "health": ch.get("Health") or "ACTIVE",
			"connected_at": _date(ch.get("Дата подключения")), "last_activity": _date(ch.get("Последняя активность")),
			"disconnected_at": _date(ch.get("Дата отключения")), "last_error": ch.get("Последняя ошибка"),
		})
	doc.legacy_club_synced_at = now_datetime()
	doc.legacy_club_hash = data["state_hash"]
	doc.legacy_club_revision = str(data["revision"])
	doc.save(ignore_permissions=True)
	_audit(doc, data.get("consents", []), "consents")
	_audit(doc, data.get("events", []), "events")
	# Preserve historical consent dates, never invent today's consent for imported flags.
	consent_types = {"Персональные данные": "personal_data_consent_at", "Рекламные сообщения": "marketing_consent_at", "Правила клуба": "club_rules_consent_at"}
	for kind, field in consent_types.items():
		dates = [_date(c.get("Дата/время")) for c in data.get("consents", []) if c.get("Тип согласия") == kind and truth(c.get("Согласие")) and c.get("Дата/время")]
		frappe.db.set_value("Client", doc.name, field, min(dates) if dates else None, update_modified=False)
	return "MATCH" if float(doc.discount_percent) == doc.legacy_club_discount and doc.active_channels == int(row.get("Активных каналов") or 0) else "DIFFERENCE"


@frappe.whitelist(allow_guest=True, methods=["POST"])
def receive(payload=None, timestamp=None, signature=None):
	s = _settings()
	if not s.enabled:
		return {"ok": False, "error": "SYNC_DISABLED"}
	try:
		data = verify(payload, timestamp, signature, s.get_password("shared_secret", raise_exception=False), time.time())
	except (ValueError, TypeError):
		frappe.local.response.http_status_code = 403
		return {"ok": False, "error": "INVALID_SIGNED_REQUEST"}
	if data.get("source_id") != s.source_id:
		frappe.local.response.http_status_code = 403
		return {"ok": False, "error": "SOURCE_MISMATCH"}
	# Serialize imports, including first insertion and duplicate event delivery.
	frappe.db.sql("SELECT name FROM `tabDocType` WHERE name='Club Sync Receipt' FOR UPDATE")
	key = digest(s.source_id + ":" + data["event_id"])
	if frappe.db.exists("Club Sync Receipt", key):
		return {"ok": True, "duplicate": True}
	frappe.db.savepoint("club_shadow_event")
	try:
		outcome = _apply(data, s)
		if data.get("dry_run") is True:
			frappe.db.rollback(save_point="club_shadow_event")
			return {"ok": True, "dry_run": True, "outcome": outcome}
		frappe.get_doc({"doctype": "Club Sync Receipt", "name": key, "outcome": outcome, "received_at": now_datetime()}).insert(ignore_permissions=True)
		frappe.db.set_single_value("Club Shadow Settings", "last_received_at", now_datetime())
	except ValueError as exc:
		frappe.db.rollback(save_point="club_shadow_event")
		known = {"POINT_NOT_FOUND", "EXPECTED_YAROSLAVL_KOMSOMOLSKAYA_12", "CLIENT_ID_AND_PHONE_REQUIRED", "PHONE_ID_CONFLICT", "OS_CLIENT_REQUIRES_MANUAL_MATCH", "UNKNOWN_CHANNEL", "AUDIT_ID_REQUIRED"}
		return {"ok": False, "error": str(exc) if str(exc) in known else "INVALID_SOURCE_VALUE"}
	except Exception:
		frappe.db.rollback(save_point="club_shadow_event")
		# No exception traceback: it could contain phone numbers or bearer tokens.
		return {"ok": False, "error": "IMPORT_REJECTED_CHECK_ID_POINT_CHANNELS"}
	return {"ok": True, "outcome": outcome}
