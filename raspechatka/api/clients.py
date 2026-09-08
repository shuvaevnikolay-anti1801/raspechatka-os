import json
import re
from datetime import date

import frappe
from frappe import _
from frappe.utils import add_days, cint, date_diff, flt, getdate, now_datetime, today

from raspechatka.access import get_scope, require_access
from raspechatka.raspechatka_os.doctype.client.client import CHANNELS, normalize_phone

MARKETING_TYPES = {
	"segments": {
		"doctype": "Client Segment",
		"fields": [
			"name",
			"segment_name",
			"active",
			"marketing_consent_only",
			"business_point",
			"club_status",
			"minimum_discount_percent",
			"minimum_active_channels",
			"birthday_days_ahead",
			"modified",
		],
		"search": ("segment_name", "notes"),
		"order_by": "segment_name asc",
		"area": "clients.marketing",
	},
	"campaigns": {
		"doctype": "Promo Campaign",
		"fields": [
			"name",
			"campaign_name",
			"status",
			"segment",
			"occasion",
			"channel",
			"planned_at",
			"promo_code",
			"audience_count",
			"sent_count",
			"purchase_count",
			"revenue",
			"modified",
		],
		"search": ("campaign_name", "message_text", "notes"),
		"order_by": "modified desc",
		"area": "clients.marketing",
	},
	"promo-codes": {
		"doctype": "Promo Code",
		"fields": [
			"name",
			"code",
			"active",
			"campaign",
			"discount_type",
			"discount_value",
			"valid_from",
			"valid_to",
			"maximum_uses",
			"uses_count",
			"modified",
		],
		"search": ("code", "notes"),
		"order_by": "valid_from desc",
		"area": "clients.loyalty",
	},
	"calendar": {
		"doctype": "Promo Occasion",
		"fields": [
			"name",
			"occasion_name",
			"occasion_type",
			"event_date",
			"recurring_annually",
			"prepare_days_before",
			"active",
			"modified",
		],
		"search": ("occasion_name", "notes"),
		"order_by": "event_date asc",
		"area": "clients.marketing",
	},
}


def _visible_client_names():
	scope = get_scope()
	if scope.get("global"):
		return None
	points = scope.get("points") or ["__none__"]
	names = set(
		frappe.get_all(
			"Client", filters={"registration_point": ["in", points]}, pluck="name", limit_page_length=0
		)
	)
	names.update(
		frappe.get_all(
			"Client Purchase", filters={"business_point": ["in", points]}, pluck="client", limit_page_length=0
		)
	)
	return list(names) or ["__none__"]


def _require_client_visible(name):
	names = _visible_client_names()
	if names is not None and name not in names:
		frappe.throw(_("Клиент недоступен для вашей точки"), frappe.PermissionError)


def _log(
	client=None,
	event_type="",
	channel=None,
	source=None,
	status=None,
	external_id=None,
	details=None,
	error=None,
):
	frappe.get_doc(
		{
			"doctype": "Client Event Log",
			"client": client,
			"event_type": event_type,
			"channel": channel,
			"source": source,
			"status": status,
			"external_id": external_id,
			"details": json.dumps(details, ensure_ascii=False, default=str)
			if isinstance(details, (dict, list))
			else details,
			"error": error,
		}
	).insert(ignore_permissions=True)


def _record_consent(
	client,
	consent_type,
	accepted,
	version,
	url=None,
	source=None,
	submission_id=None,
	ip_address=None,
	user_agent=None,
):
	frappe.get_doc(
		{
			"doctype": "Client Consent",
			"client": client,
			"consent_type": consent_type,
			"accepted": cint(accepted),
			"document_version": version or "1.0",
			"document_url": url,
			"source": source,
			"submission_id": submission_id,
			"ip_address": ip_address,
			"user_agent": user_agent,
			"revoked_at": None if accepted else now_datetime(),
		}
	).insert(ignore_permissions=True)


def _point_name(value):
	value = str(value or "").strip()
	if not value:
		return None
	if frappe.db.exists("Business Point", value):
		return value
	return frappe.db.get_value("Business Point", {"point_code": value, "active": 1}, "name")


def _public_client(data):
	session = (data.get("session_token") or "").strip()
	link = (data.get("link_token") or data.get("club_link_token") or "").strip()
	if session:
		name = frappe.db.get_value(
			"Client", {"session_token": session, "session_expires": [">", now_datetime()]}, "name"
		)
		if name:
			return frappe.get_doc("Client", name)
	if link:
		name = frappe.db.get_value("Client", {"link_token": link}, "name")
		if name:
			return frappe.get_doc("Client", name)
	return None


def _public_result(doc):
	return {
		"ok": True,
		"client_id": doc.client_id,
		"name": doc.client_name,
		"discount": flt(doc.discount_percent),
		"active_channels": cint(doc.active_channels),
		"primary_channel": doc.primary_channel or "",
		"backup_channel": doc.backup_channel or "",
		"telegram": bool(doc.telegram_active),
		"max": bool(doc.max_active),
		"vk": bool(doc.vk_active),
	}


def _external_response(result, callback=None):
	"""Return raw JSON/JSONP compatible with the existing Tilda and BotHelp code."""
	callback = str(callback or "").strip()
	if callback and not re.fullmatch(r"[A-Za-z_$][0-9A-Za-z_$]*", callback):
		result = {"ok": False, "error": "INVALID_CALLBACK"}
		callback = ""
	content = json.dumps(result, ensure_ascii=False, default=str)
	frappe.local.response.type = "download"
	frappe.local.response.filename = "club-response.js" if callback else "club-response.json"
	frappe.local.response.filecontent = f"{callback}({content});" if callback else content
	frappe.local.response.display_content_as = "inline"
	frappe.local.response.content_type = (
		"application/javascript; charset=utf-8" if callback else "application/json; charset=utf-8"
	)
	return result


@frappe.whitelist(allow_guest=True)
def club_gateway(data=None, **kwargs):
	"""Compatibility gateway for the existing Tilda/BotHelp page."""
	payload = frappe.parse_json(data) if data else kwargs
	callback = payload.get("callback")
	if payload.get("bothelp_user_id") or (payload.get("user_id") and payload.get("club_link_token")):
		return _external_response(bothelp_webhook(data=payload))
	action = str(payload.get("action") or "register").strip()
	if action == "check_phone":
		result = check_phone(payload.get("phone"), payload.get("session_token"), payload.get("link_token"))
		return _external_response(result, callback)
	if action == "register":
		return _external_response(register_client(data=payload))
	if action == "connect_channel":
		return _external_response(connect_channel(data=payload))
	if action == "disconnect_channel":
		return _external_response(disconnect_channel(data=payload))
	if action in ("get_client", "open_client"):
		doc = _public_client(payload)
		result = (
			_public_result(doc)
			if doc
			else {"ok": False, "error": "SESSION_REQUIRED", "verification_required": True}
		)
		return _external_response(result, callback)
	return _external_response(
		{"ok": False, "error": "UNKNOWN_ACTION", "message": f"Неизвестное действие: {action}"}
	)


@frappe.whitelist()
def get_clients(search=None, club_status=None, business_point=None, channel=None):
	require_access("clients.base", "read")
	filters = {}
	visible = _visible_client_names()
	if visible is not None:
		filters["name"] = ["in", visible]
	if club_status:
		filters["club_status"] = club_status
	if business_point:
		filters["registration_point"] = business_point
	if channel in CHANNELS:
		filters[{"Telegram": "telegram_active", "MAX": "max_active", "VK": "vk_active"}[channel]] = 1
	or_filters = None
	if search:
		value = f"%{search.strip()}%"
		or_filters = {field: ["like", value] for field in ("client_id", "client_name", "phone", "email")}
	return frappe.get_all(
		"Client",
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name",
			"client_id",
			"client_name",
			"phone",
			"email",
			"birth_date",
			"registration_point",
			"registered_at",
			"club_status",
			"discount_percent",
			"active_channels",
			"primary_channel",
			"personal_data_consent",
			"marketing_consent",
			"club_rules_consent",
			"active",
		],
		order_by="registered_at desc",
		limit_page_length=1000,
	)


@frappe.whitelist()
def get_client(name):
	require_access("clients.base", "read")
	_require_client_visible(name)
	doc = frappe.get_doc("Client", name)
	result = doc.as_dict(no_nulls=False)
	for secret_field in ("link_token", "session_token", "channel_token"):
		result.pop(secret_field, None)
	result["consents"] = frappe.get_all(
		"Client Consent",
		filters={"client": name},
		fields=[
			"name",
			"consent_type",
			"accepted",
			"recorded_at",
			"document_version",
			"document_url",
			"source",
			"revoked_at",
		],
		order_by="recorded_at desc",
		limit_page_length=200,
	)
	result["purchases"] = frappe.get_all(
		"Client Purchase",
		filters={"client": name},
		fields=[
			"name",
			"purchase_datetime",
			"business_point",
			"source_document",
			"gross_amount",
			"discount_amount",
			"net_amount",
			"loyalty_discount_percent",
			"promo_code",
			"campaign",
			"cancelled",
		],
		order_by="purchase_datetime desc",
		limit_page_length=200,
	)
	result["events"] = frappe.get_all(
		"Client Event Log",
		filters={"client": name},
		fields=["name", "event_datetime", "event_type", "channel", "source", "status", "details", "error"],
		order_by="event_datetime desc",
		limit_page_length=200,
	)
	scope = get_scope()
	if not scope.get("global"):
		result["purchases"] = [
			row for row in result["purchases"] if row.business_point in scope.get("points", [])
		]
		result["events"] = []
	return result


@frappe.whitelist(methods=["POST"])
def save_client(data):
	require_access("clients.base", "write")
	data = frappe.parse_json(data)
	name = data.get("name")
	if name:
		_require_client_visible(name)
	scope = get_scope()
	if not scope.get("global") and data.get("registration_point") not in scope.get("points", []):
		frappe.throw(_("Точка регистрации недоступна"), frappe.PermissionError)
	doc = frappe.get_doc("Client", name) if name else frappe.new_doc("Client")
	old = doc.as_dict() if name else {}
	for fieldname in (
		"active",
		"last_name",
		"first_name",
		"middle_name",
		"birth_date",
		"phone",
		"email",
		"registration_point",
		"registration_source",
		"personal_data_consent",
		"marketing_consent",
		"club_rules_consent",
		"notes",
	):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	if "messengers" in data:
		doc.set("messengers", [])
		for row in data.get("messengers") or []:
			doc.append(
				"messengers",
				{
					key: row.get(key)
					for key in (
						"messenger_type",
						"contact",
						"platform_user_id",
						"bothelp_subscriber_id",
						"status",
						"connected_at",
						"last_activity",
						"health",
						"last_error",
						"disconnected_at",
					)
				},
			)
	doc.save(ignore_permissions=True)
	settings = frappe.get_single("Loyalty Settings")
	consents = (
		(
			"personal_data_consent",
			"Персональные данные",
			settings.personal_data_version,
			settings.personal_data_url,
		),
		("marketing_consent", "Рекламные сообщения", settings.marketing_version, settings.marketing_url),
		("club_rules_consent", "Правила клуба", settings.club_rules_version, settings.club_rules_url),
	)
	for fieldname, consent_type, version, url in consents:
		changed = (not name and cint(doc.get(fieldname))) or (
			name and cint(old.get(fieldname)) != cint(doc.get(fieldname))
		)
		if fieldname in data and changed:
			_record_consent(doc.name, consent_type, doc.get(fieldname), version, url, "Распечатка ОС")  # noqa: RUF001
	_log(doc.name, "CLIENT_UPDATED" if name else "CLIENT_CREATED", source="Распечатка ОС")  # noqa: RUF001
	return {"name": doc.name, "client_id": doc.client_id}


@frappe.whitelist()
def get_client_options():
	require_access("clients.base", "read")
	return {
		"points": frappe.get_all(
			"Business Point",
			filters={"active": 1},
			fields=["name", "point_name", "point_code"],
			order_by="point_name asc",
		),
		"segments": frappe.get_all(
			"Client Segment",
			filters={"active": 1},
			fields=["name", "segment_name"],
			order_by="segment_name asc",
		),
		"occasions": frappe.get_all(
			"Promo Occasion",
			filters={"active": 1},
			fields=["name", "occasion_name", "event_date"],
			order_by="event_date asc",
		),
		"promo_codes": frappe.get_all("Promo Code", fields=["name", "code", "active"], order_by="code asc"),
	}


@frappe.whitelist()
def get_club_dashboard():
	require_access("clients.base", "read")
	now = getdate(today())
	month_start = now.replace(day=1)
	rows = frappe.get_all(
		"Client", fields=["name", "birth_date", "registered_at", "club_status", "marketing_consent"]
	)
	this_month = sum(1 for row in rows if row.registered_at and getdate(row.registered_at) >= month_start)
	birthdays_month = sum(1 for row in rows if row.birth_date and getdate(row.birth_date).month == now.month)
	return {
		"total_clients": len(rows),
		"new_this_month": this_month,
		"active_clients": sum(1 for row in rows if row.club_status == "Активен"),
		"awaiting_channel": sum(1 for row in rows if row.club_status == "Ожидает мессенджер"),
		"marketing_allowed": sum(1 for row in rows if row.marketing_consent),
		"birthdays_this_month": birthdays_month,
		"campaigns_planned": frappe.db.count("Promo Campaign", {"status": "Запланирована"}),
		"sent_total": frappe.db.sum("Promo Campaign", "sent_count") or 0,
		"purchases_from_campaigns": frappe.db.count(
			"Client Purchase", {"campaign": ["is", "set"], "cancelled": 0}
		),
	}


@frappe.whitelist()
def get_loyalty_settings():
	require_access("clients.loyalty", "read")
	return frappe.get_single("Loyalty Settings").as_dict(no_nulls=False)


@frappe.whitelist(methods=["POST"])
def save_loyalty_settings(data):
	require_access("clients.loyalty", "write")
	data = frappe.parse_json(data)
	doc = frappe.get_single("Loyalty Settings")
	for fieldname in (
		"club_name",
		"active",
		"max_active_channels",
		"maximum_discount_percent",
		"personal_data_required",
		"marketing_required",
		"club_rules_required",
		"personal_data_version",
		"personal_data_url",
		"marketing_version",
		"marketing_url",
		"club_rules_version",
		"club_rules_url",
		"session_lifetime_days",
		"telegram_connect_url",
		"max_connect_url",
		"vk_connect_url",
	):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	if "discount_rules" in data:
		doc.set("discount_rules", [])
		for row in data.get("discount_rules") or []:
			doc.append(
				"discount_rules",
				{
					"active_channel_count": row.get("active_channel_count"),
					"discount_percent": row.get("discount_percent"),
					"active": cint(row.get("active", 1)),
				},
			)
	doc.save(ignore_permissions=True)
	frappe.enqueue(
		"raspechatka.api.clients.recalculate_all_discounts", queue="long", enqueue_after_commit=True
	)
	return {"saved": True}


def recalculate_all_discounts():
	for name in frappe.get_all("Client", pluck="name", limit_page_length=100000):
		doc = frappe.get_doc("Client", name)
		if doc.get("legacy_club_id"):
			continue
		doc.save(ignore_permissions=True)


def _segment_members(doc):
	filters = {"active": 1}
	if doc.marketing_consent_only:
		filters["marketing_consent"] = 1
	if doc.business_point:
		filters["registration_point"] = doc.business_point
	if doc.club_status:
		filters["club_status"] = doc.club_status
	if doc.minimum_discount_percent:
		filters["discount_percent"] = [">=", doc.minimum_discount_percent]
	if doc.minimum_active_channels:
		filters["active_channels"] = [">=", doc.minimum_active_channels]
	if doc.registered_from or doc.registered_to:
		filters["registered_at"] = [
			"between",
			[doc.registered_from or "2000-01-01", doc.registered_to or "2999-12-31"],
		]
	rows = frappe.get_all(
		"Client",
		filters=filters,
		fields=[
			"name",
			"client_id",
			"client_name",
			"phone",
			"birth_date",
			"primary_channel",
			"backup_channel",
			"discount_percent",
			"registration_point",
		],
		limit_page_length=10000,
	)
	if cint(doc.birthday_days_ahead):
		today_date = getdate(today())
		filtered = []
		for row in rows:
			if not row.birth_date:
				continue
			birth = getdate(row.birth_date)
			try:
				next_date = date(today_date.year, birth.month, birth.day)
			except ValueError:
				next_date = date(today_date.year, 2, 28)
			if next_date < today_date:
				next_date = next_date.replace(year=today_date.year + 1)
			if 0 <= date_diff(next_date, today_date) <= cint(doc.birthday_days_ahead):
				filtered.append(row)
		rows = filtered
	return rows


@frappe.whitelist()
def get_marketing_records(kind, search=None, status=None):
	config = MARKETING_TYPES.get(kind)
	if not config:
		frappe.throw(_("Неизвестный раздел"))
	require_access(config["area"], "read")
	filters = {}
	if status:
		filters["status" if kind == "campaigns" else "active"] = status
	or_filters = None
	if search:
		value = f"%{search.strip()}%"
		or_filters = {field: ["like", value] for field in config["search"]}
	rows = frappe.get_all(
		config["doctype"],
		fields=config["fields"],
		filters=filters,
		or_filters=or_filters,
		order_by=config["order_by"],
		limit_page_length=1000,
	)
	if kind == "segments":
		for row in rows:
			row["audience_count"] = len(_segment_members(frappe.get_doc("Client Segment", row.name)))
	if kind == "campaigns":
		for row in rows:
			row["purchase_count"] = frappe.db.count("Client Purchase", {"campaign": row.name, "cancelled": 0})
			row["revenue"] = (
				frappe.db.sum("Client Purchase", "net_amount", {"campaign": row.name, "cancelled": 0}) or 0
			)
	return rows


@frappe.whitelist()
def get_marketing_record(kind, name):
	config = MARKETING_TYPES.get(kind)
	if not config:
		frappe.throw(_("Неизвестный раздел"))
	require_access(config["area"], "read")
	doc = frappe.get_doc(config["doctype"], name)
	result = doc.as_dict(no_nulls=False)
	if kind == "segments":
		result["members"] = _segment_members(doc)[:500]
	elif kind == "campaigns":
		result["purchase_count"] = frappe.db.count("Client Purchase", {"campaign": name, "cancelled": 0})
		result["revenue"] = (
			frappe.db.sum("Client Purchase", "net_amount", {"campaign": name, "cancelled": 0}) or 0
		)
	return result


@frappe.whitelist(methods=["POST"])
def save_marketing_record(kind, data):
	config = MARKETING_TYPES.get(kind)
	if not config:
		frappe.throw(_("Неизвестный раздел"))
	require_access(config["area"], "write")
	data = frappe.parse_json(data)
	name = data.get("name")
	doc = frappe.get_doc(config["doctype"], name) if name else frappe.new_doc(config["doctype"])
	allowed = {
		"segments": (
			"segment_name",
			"active",
			"marketing_consent_only",
			"business_point",
			"club_status",
			"minimum_discount_percent",
			"minimum_active_channels",
			"birthday_days_ahead",
			"registered_from",
			"registered_to",
			"notes",
		),
		"campaigns": (
			"campaign_name",
			"status",
			"segment",
			"occasion",
			"channel",
			"planned_at",
			"promo_code",
			"message_text",
			"notes",
		),
		"promo-codes": (
			"code",
			"active",
			"campaign",
			"discount_type",
			"discount_value",
			"valid_from",
			"valid_to",
			"maximum_uses",
			"one_use_per_client",
			"notes",
		),
		"calendar": (
			"occasion_name",
			"occasion_type",
			"event_date",
			"recurring_annually",
			"prepare_days_before",
			"active",
			"notes",
		),
	}[kind]
	for fieldname in allowed:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	if kind == "campaigns" and doc.segment:
		doc.audience_count = len(_segment_members(frappe.get_doc("Client Segment", doc.segment)))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(allow_guest=True)
def check_phone(phone, session_token=None, link_token=None):
	phone = normalize_phone(phone)
	if not phone:
		return {"ok": False, "error": "INVALID_PHONE", "message": "Некорректный номер телефона"}
	name = frappe.db.get_value("Client", {"phone": phone}, "name")
	if not name:
		return {"ok": True, "exists": False, "can_register": True, "authenticated": False}
	doc = _public_client({"session_token": session_token, "link_token": link_token})
	if not doc or doc.name != name:
		return {
			"ok": True,
			"exists": True,
			"can_register": False,
			"authenticated": False,
			"verification_required": True,
		}
	return {
		**_public_result(doc),
		"exists": True,
		"can_register": False,
		"authenticated": True,
		"verification_required": False,
	}


@frappe.whitelist(allow_guest=True)
def get_club_config(point_code=None):
	settings = frappe.get_single("Loyalty Settings")
	point = _point_name(point_code)
	return {
		"active": bool(settings.active),
		"club_name": settings.club_name,
		"point": point,
		"point_name": frappe.db.get_value("Business Point", point, "point_name") if point else None,
		"personal_data": {
			"required": bool(settings.personal_data_required),
			"url": settings.personal_data_url,
			"version": settings.personal_data_version,
		},
		"marketing": {
			"required": bool(settings.marketing_required),
			"url": settings.marketing_url,
			"version": settings.marketing_version,
		},
		"club_rules": {
			"required": bool(settings.club_rules_required),
			"url": settings.club_rules_url,
			"version": settings.club_rules_version,
		},
		"connect_urls": {
			"Telegram": settings.telegram_connect_url,
			"MAX": settings.max_connect_url,
			"VK": settings.vk_connect_url,
		},
	}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def register_client(data=None, **kwargs):
	data = frappe.parse_json(data) if data else kwargs
	phone = normalize_phone(data.get("phone"))
	point = _point_name(data.get("registration_point") or data.get("point") or data.get("point_code"))
	if not phone:
		return {"ok": False, "error": "INVALID_PHONE", "message": "Некорректный номер телефона"}
	if not point:
		return {"ok": False, "error": "POINT_REQUIRED", "message": "Не удалось определить точку регистрации"}  # noqa: RUF001
	settings = frappe.get_single("Loyalty Settings")
	consent_values = {
		"personal_data_consent": cint(data.get("consent_pd")),
		"marketing_consent": cint(data.get("consent_ads")),
		"club_rules_consent": cint(data.get("consent_rules")),
	}
	if (
		(settings.personal_data_required and not consent_values["personal_data_consent"])
		or (settings.marketing_required and not consent_values["marketing_consent"])
		or (settings.club_rules_required and not consent_values["club_rules_consent"])
	):
		return {
			"ok": False,
			"error": "CONSENTS_REQUIRED",
			"message": "Для вступления в клуб необходимо подтвердить все обязательные согласия.",
		}
	name = frappe.db.get_value("Client", {"phone": phone}, "name")
	link_token = (data.get("link_token") or frappe.generate_hash(length=40)).strip()
	if name:
		doc = frappe.get_doc("Client", name)
		auth = _public_client(data)
		if not auth or auth.name != doc.name:
			_log(doc.name, "EXISTING_CLIENT_BLOCKED", source=data.get("source") or "Club form")
			return {
				"ok": False,
				"error": "EXISTING_CLIENT_REQUIRES_VERIFICATION",
				"message": "Этот номер уже зарегистрирован. Требуется подтверждение входа.",
				"exists": True,
				"verification_required": True,
			}
	else:
		doc = frappe.new_doc("Client")
		doc.phone = phone
		doc.first_name = (data.get("name") or data.get("first_name") or "Клиент").strip()
		doc.registration_point = point
		doc.registration_source = data.get("source") or "Клуб Распечатка"
	for fieldname, value in consent_values.items():
		doc.set(fieldname, value)
	doc.link_token = link_token
	session_token = doc.issue_session()
	channel_token = doc.issue_channel_token()
	doc.save(ignore_permissions=True)
	consent_meta = (
		(
			"personal_data_consent",
			"Персональные данные",
			settings.personal_data_version,
			data.get("pd_url") or settings.personal_data_url,
		),
		(
			"marketing_consent",
			"Рекламные сообщения",
			settings.marketing_version,
			data.get("ads_url") or settings.marketing_url,
		),
		(
			"club_rules_consent",
			"Правила клуба",
			settings.club_rules_version,
			data.get("rules_url") or settings.club_rules_url,
		),
	)
	for fieldname, consent_type, version, url in consent_meta:
		if consent_values[fieldname]:
			_record_consent(
				doc.name,
				consent_type,
				True,
				version,
				url,
				data.get("source") or "Клуб Распечатка",
				data.get("submission_id"),
				data.get("ip") or getattr(frappe.local, "request_ip", None),
				data.get("user_agent") or frappe.get_request_header("User-Agent"),
			)
	_log(
		doc.name,
		"CLIENT_SESSION_RENEWED" if name else "CLIENT_CREATED",
		source=doc.registration_source,
		details={"point": point},
	)
	return {
		**_public_result(doc),
		"link_token": link_token,
		"session_token": session_token,
		"channel_token": channel_token,
		"existing": bool(name),
	}


@frappe.whitelist(allow_guest=True)
def get_public_client(session_token=None, link_token=None):
	doc = _public_client({"session_token": session_token, "link_token": link_token})
	return _public_result(doc) if doc else {"ok": False, "error": "CLIENT_NOT_FOUND"}


def _connect_channel(doc, channel, platform_user_id=None, bothelp_subscriber_id=None, contact=None):
	if channel not in CHANNELS:
		frappe.throw(_("Неизвестный канал"))
	row = next((item for item in doc.messengers if item.messenger_type == channel), None)
	if (not row or row.status != "Активен") and cint(doc.active_channels) >= cint(
		frappe.get_single("Loyalty Settings").max_active_channels or 2
	):
		return {
			"ok": False,
			"error": "MAX_ACTIVE_CHANNELS",
			"message": "У клиента уже подключены основной и резервный каналы.",  # noqa: RUF001
			**_public_result(doc),
		}
	if not row:
		row = doc.append("messengers", {"messenger_type": channel})
	row.contact = contact or row.contact
	row.platform_user_id = platform_user_id or row.platform_user_id
	row.bothelp_subscriber_id = bothelp_subscriber_id or row.bothelp_subscriber_id
	row.status = "Активен"
	row.connected_at = row.connected_at or now_datetime()
	row.last_activity = now_datetime()
	row.health = "ACTIVE"
	row.last_error = ""
	row.disconnected_at = None
	doc.save(ignore_permissions=True)
	_log(
		doc.name,
		"CHANNEL_CONNECTED",
		channel=channel,
		source="BotHelp" if bothelp_subscriber_id else "Клуб Распечатка",
		external_id=bothelp_subscriber_id or platform_user_id,
	)
	return {**_public_result(doc), "channel": channel}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def connect_channel(data=None, **kwargs):
	data = frappe.parse_json(data) if data else kwargs
	token = (data.get("token") or "").strip()
	doc = None
	if token:
		name = frappe.db.get_value(
			"Client", {"channel_token": token, "channel_token_expires": [">", now_datetime()]}, "name"
		)
		doc = frappe.get_doc("Client", name) if name else None
	doc = doc or _public_client(data)
	if not doc:
		return {"ok": False, "error": "INVALID_TOKEN", "message": "Недействительный или просроченный токен"}
	return _connect_channel(
		doc,
		_normalize_channel(data.get("channel") or data.get("messenger")),
		data.get("platform_user_id") or data.get("user_id"),
		data.get("bothelp_subscriber_id") or data.get("subscriber_id"),
		data.get("contact"),
	)


@frappe.whitelist(allow_guest=True, methods=["POST"])
def disconnect_channel(data=None, **kwargs):
	data = frappe.parse_json(data) if data else kwargs
	doc = _public_client(data)
	if not doc:
		return {"ok": False, "error": "SESSION_REQUIRED"}
	channel = _normalize_channel(data.get("channel"))
	row = next((item for item in doc.messengers if item.messenger_type == channel), None)
	if row:
		row.status = "Отключен"
		row.health = "DEAD"
		row.disconnected_at = now_datetime()
		doc.save(ignore_permissions=True)
		_log(doc.name, "CHANNEL_DISCONNECTED", channel=channel, source="Клуб Распечатка")
	return _public_result(doc)


def _normalize_channel(value):
	value = str(value or "").strip().lower()
	return {
		"telegram": "Telegram",
		"tg": "Telegram",
		"max": "MAX",
		"макс": "MAX",
		"vk": "VK",
		"вк": "VK",
		"vkontakte": "VK",
	}.get(value, "")


@frappe.whitelist(allow_guest=True, methods=["POST"])
def bothelp_webhook(data=None, **kwargs):
	data = frappe.parse_json(data) if data else kwargs
	settings = frappe.get_single("Loyalty Settings")
	secret = settings.get_password("bothelp_webhook_secret", raise_exception=False)
	if secret and data.get("secret") != secret:
		frappe.throw(_("Неверная подпись webhook"), frappe.PermissionError)
	link = data.get("club_link_token") or (
		data.get("utm_campaign") if str(data.get("utm_source", "")).lower() == "club" else None
	)
	doc = _public_client({"link_token": link})
	if not doc:
		return {"ok": False, "error": "CLIENT_NOT_FOUND"}
	channel = _normalize_channel(
		data.get("club_channel")
		or data.get("channel")
		or data.get("messenger")
		or ("vk" if str(data.get("utm_medium", "")).lower() == "vk" else "telegram")
	)
	result = _connect_channel(doc, channel, data.get("user_id"), data.get("bothelp_user_id"))
	_log(doc.name, "BOTHELP_WEBHOOK", channel=channel, source="BotHelp", details=data)
	return result


@frappe.whitelist()
def lookup_client(phone):
	require_access("clients.base", "read")
	phone = normalize_phone(phone)
	name = frappe.db.get_value("Client", {"phone": phone, "active": 1}, "name") if phone else None
	if not name:
		return {"found": False}
	doc = frappe.get_doc("Client", name)
	return {
		"found": True,
		"name": doc.name,
		"client_id": doc.client_id,
		"client_name": doc.client_name,
		"phone": doc.phone,
		"discount_percent": flt(doc.discount_percent),
		"club_status": doc.club_status,
	}


@frappe.whitelist()
def validate_promo_code(code, client=None, amount=0):
	require_access("clients.base", "read")
	now = now_datetime()
	name = frappe.db.get_value("Promo Code", {"code": str(code or "").strip().upper(), "active": 1}, "name")
	if not name:
		return {"valid": False, "message": "Промокод не найден"}
	doc = frappe.get_doc("Promo Code", name)
	if now < doc.valid_from or now > doc.valid_to:
		return {"valid": False, "message": "Срок действия промокода истёк"}
	if cint(doc.maximum_uses) and cint(doc.uses_count) >= cint(doc.maximum_uses):
		return {"valid": False, "message": "Лимит применений исчерпан"}
	if (
		client
		and doc.one_use_per_client
		and frappe.db.exists("Client Purchase", {"client": client, "promo_code": doc.name, "cancelled": 0})
	):
		return {"valid": False, "message": "Клиент уже использовал этот промокод"}
	discount = (
		flt(amount) * flt(doc.discount_value) / 100
		if doc.discount_type == "Процент"
		else min(flt(amount), flt(doc.discount_value))
	)
	return {
		"valid": True,
		"promo_code": doc.name,
		"discount_type": doc.discount_type,
		"discount_value": flt(doc.discount_value),
		"discount_amount": discount,
		"campaign": doc.campaign,
	}


@frappe.whitelist(methods=["POST"])
def record_purchase(data):
	require_access("clients.base", "write")
	data = frappe.parse_json(data)
	client = data.get("client") or frappe.db.get_value(
		"Client", {"phone": normalize_phone(data.get("phone"))}, "name"
	)
	if not client:
		frappe.throw(_("Клиент не найден"))
	doc = frappe.get_doc(
		{
			"doctype": "Client Purchase",
			**{
				key: data.get(key)
				for key in (
					"business_point",
					"source_doctype",
					"source_document",
					"gross_amount",
					"discount_amount",
					"net_amount",
					"loyalty_discount_percent",
					"promo_code",
					"campaign",
				)
			},
			"client": client,
			"purchase_datetime": data.get("purchase_datetime") or now_datetime(),
		}
	)
	doc.insert(ignore_permissions=True)
	if doc.promo_code:
		frappe.db.set_value(
			"Promo Code",
			doc.promo_code,
			"uses_count",
			frappe.db.count("Client Purchase", {"promo_code": doc.promo_code, "cancelled": 0}),
			update_modified=False,
		)
	_log(
		client,
		"PURCHASE_RECORDED",
		source="POS",
		external_id=doc.source_document,
		details={"amount": doc.net_amount, "promo_code": doc.promo_code},
	)
	return {"name": doc.name}
