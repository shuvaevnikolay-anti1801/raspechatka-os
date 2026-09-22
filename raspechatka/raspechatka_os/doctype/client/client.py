import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.model.naming import NamingSeries, make_autoname
from frappe.utils import add_days, cint, flt, now_datetime

CHANNELS = ("Telegram", "MAX", "VK")
SUPPORTED_MESSENGERS = (*CHANNELS, "WhatsApp")

CLIENT_ID_AUTONAME = "RP-.######"
CLIENT_ID_PATTERN = re.compile(r"^RP-(\d+)$")


def _client_id_number(value):
	match = CLIENT_ID_PATTERN.fullmatch(str(value or "").strip())
	return int(match.group(1)) if match else 0


def sync_client_id_series(minimum=0):
	"""Advance the RP- series to at least the largest ID already present in Client."""
	rows = frappe.db.sql(
		"""
		SELECT MAX(CAST(SUBSTRING(`client_id`, 4) AS UNSIGNED))
		FROM `tabClient`
		WHERE `client_id` REGEXP '^RP-[0-9]+$'
		"""
	)
	existing_max = cint(rows[0][0]) if rows and rows[0] else 0
	target = max(cint(minimum), existing_max)
	series = NamingSeries(CLIENT_ID_AUTONAME)
	current = series.get_current_value()
	if target > current:
		series.update_counter(target)
		return target
	return current


def next_client_id():
	"""Allocate a collision-safe RP- identifier even after legacy/manual imports."""
	sync_client_id_series()
	for _attempt in range(3):
		candidate = make_autoname(CLIENT_ID_AUTONAME)
		if not frappe.db.exists("Client", {"client_id": candidate}):
			return candidate
		sync_client_id_series(_client_id_number(candidate))
	frappe.throw(_("Не удалось сформировать уникальный ID клиента. Повторите регистрацию."))  # noqa: RUF001


def normalize_phone(value):
	digits = re.sub(r"\D", "", str(value or ""))
	if len(digits) == 11 and digits.startswith("8"):
		digits = "7" + digits[1:]
	if len(digits) == 10:
		digits = "7" + digits
	if len(digits) != 11 or not digits.startswith("7"):
		return ""
	return "+" + digits


def get_loyalty_settings():
	try:
		return frappe.get_single("Loyalty Settings")
	except Exception:
		return None


def _value(row, fieldname, default=None):
	if isinstance(row, dict):
		return row.get(fieldname, default)
	return getattr(row, fieldname, default)


def calculate_loyalty_state(client, messengers=None, settings=None):
	"""Calculate every derived loyalty field without mutating the client record."""
	messengers = list(messengers if messengers is not None else _value(client, "messengers", []) or [])
	active = [
		row
		for row in messengers
		if _value(row, "status") == "Активен" and _value(row, "messenger_type") in CHANNELS
	]
	active_types = {_value(row, "messenger_type") for row in active}
	settings = settings if settings is not None else get_loyalty_settings()
	eligible = bool(
		(
			not settings
			or not cint(_value(settings, "personal_data_required"))
			or cint(_value(client, "personal_data_consent"))
		)
		and (
			not settings
			or not cint(_value(settings, "marketing_required"))
			or cint(_value(client, "marketing_consent"))
		)
		and (
			not settings
			or not cint(_value(settings, "club_rules_required"))
			or cint(_value(client, "club_rules_consent"))
		)
	)

	if not cint(_value(client, "active")):
		club_status = "Заблокирован"
	elif active and eligible:
		club_status = "Активен"
	elif eligible:
		club_status = "Ожидает мессенджер"
	else:
		club_status = "Регистрация"

	discount = 0.0
	if club_status == "Активен" and settings and cint(_value(settings, "active")):
		channel_limit = cint(_value(settings, "max_active_channels"))
		channel_count = min(len(active), channel_limit) if channel_limit > 0 else len(active)
		matching = sorted(
			(
				row
				for row in (_value(settings, "discount_rules", []) or [])
				if cint(_value(row, "active")) and cint(_value(row, "active_channel_count")) <= channel_count
			),
			key=lambda row: cint(_value(row, "active_channel_count")),
		)
		if matching:
			discount = flt(_value(matching[-1], "discount_percent"))
		maximum_discount = flt(_value(settings, "maximum_discount_percent"))
		discount = min(discount, maximum_discount)

	return {
		"club_status": club_status,
		"discount_percent": discount,
		"active_channels": len(active),
		"primary_channel": _value(active[0], "messenger_type", "") if active else "",
		"backup_channel": _value(active[1], "messenger_type", "") if len(active) > 1 else "",
		"telegram_active": cint("Telegram" in active_types),
		"max_active": cint("MAX" in active_types),
		"vk_active": cint("VK" in active_types),
		"active_messengers": active,
	}


class Client(Document):
	def before_insert(self):
		if self.client_id:
			sync_client_id_series(_client_id_number(self.client_id))
		else:
			self.client_id = next_client_id()
		self.registered_by = self.registered_by or frappe.session.user
		self.registered_at = self.registered_at or now_datetime()
		self.registration_source = self.registration_source or "Распечатка ОС"  # noqa: RUF001

	def validate(self):
		self.phone = normalize_phone(self.phone)
		if not self.phone:
			frappe.throw(_("Введите российский номер телефона в формате +7XXXXXXXXXX"))
		self.client_name = " ".join(filter(None, (self.last_name, self.first_name, self.middle_name))).strip()
		self._validate_channels()
		self._set_consent_dates()
		self._recalculate_loyalty()

	def _validate_channels(self):
		seen = set()
		for row in self.messengers:
			if row.messenger_type not in SUPPORTED_MESSENGERS:
				frappe.throw(_("Неизвестный мессенджер"))
			if row.messenger_type in seen:
				frappe.throw(_("Мессенджер {0} добавлен дважды").format(row.messenger_type))
			seen.add(row.messenger_type)
		active = [
			row for row in self.messengers if row.status == "Активен" and row.messenger_type in CHANNELS
		]
		settings = get_loyalty_settings()
		limit = cint(getattr(settings, "max_active_channels", 2) or 2)
		if len(active) > limit:
			frappe.throw(_("Можно подключить не более {0} активных каналов").format(limit))

	def _set_consent_dates(self):
		for flag, timestamp in (
			("personal_data_consent", "personal_data_consent_at"),
			("marketing_consent", "marketing_consent_at"),
			("club_rules_consent", "club_rules_consent_at"),
		):
			if cint(self.get(flag)) and not self.get(timestamp):
				self.set(timestamp, now_datetime())
			if not cint(self.get(flag)):
				self.set(timestamp, None)

	def _recalculate_loyalty(self):
		state = calculate_loyalty_state(self)
		active = state.pop("active_messengers")
		for index, row in enumerate(active):
			row.channel_role = "Основной" if index == 0 else "Резервный" if index == 1 else "Дополнительный"
		for row in self.messengers:
			if row.status != "Активен":
				row.channel_role = ""
		for fieldname, value in state.items():
			self.set(fieldname, value)

	def issue_session(self):
		settings = get_loyalty_settings()
		days = cint(getattr(settings, "session_lifetime_days", 7) or 7)
		self.session_token = frappe.generate_hash(length=40)
		self.session_created = now_datetime()
		self.session_expires = add_days(self.session_created, days)
		return self.session_token

	def issue_channel_token(self):
		self.channel_token = frappe.generate_hash(length=32)
		self.channel_token_expires = add_days(now_datetime(), 1)
		return self.channel_token
