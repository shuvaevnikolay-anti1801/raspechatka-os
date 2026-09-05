import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.model.naming import make_autoname
from frappe.utils import add_days, cint, flt, now_datetime


CHANNELS = ("Telegram", "MAX", "VK")
SUPPORTED_MESSENGERS = CHANNELS + ("WhatsApp",)


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


class Client(Document):
	def before_insert(self):
		self.client_id = self.client_id or make_autoname("RP-.######")
		self.registered_by = self.registered_by or frappe.session.user
		self.registered_at = self.registered_at or now_datetime()
		self.registration_source = self.registration_source or "Распечатка ОС"

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
		active = [row for row in self.messengers if row.status == "Активен" and row.messenger_type in CHANNELS]
		settings = get_loyalty_settings()
		limit = cint(getattr(settings, "max_active_channels", 2) or 2)
		if len(active) > limit:
			frappe.throw(_("Можно подключить не более {0} активных каналов").format(limit))

	def _set_consent_dates(self):
		for flag, timestamp in (("personal_data_consent", "personal_data_consent_at"), ("marketing_consent", "marketing_consent_at"), ("club_rules_consent", "club_rules_consent_at")):
			if cint(self.get(flag)) and not self.get(timestamp):
				self.set(timestamp, now_datetime())
			if not cint(self.get(flag)):
				self.set(timestamp, None)

	def _recalculate_loyalty(self):
		active = [row for row in self.messengers if row.status == "Активен" and row.messenger_type in CHANNELS]
		for index, row in enumerate(active):
			row.channel_role = "Основной" if index == 0 else "Резервный" if index == 1 else "Дополнительный"
		for row in self.messengers:
			if row.status != "Активен":
				row.channel_role = ""
		self.active_channels = len(active)
		self.primary_channel = active[0].messenger_type if active else ""
		self.backup_channel = active[1].messenger_type if len(active) > 1 else ""
		active_types = {row.messenger_type for row in active}
		self.telegram_active = cint("Telegram" in active_types)
		self.max_active = cint("MAX" in active_types)
		self.vk_active = cint("VK" in active_types)
		settings = get_loyalty_settings()
		eligible = bool(
			(not settings or not settings.personal_data_required or self.personal_data_consent)
			and (not settings or not settings.marketing_required or self.marketing_consent)
			and (not settings or not settings.club_rules_required or self.club_rules_consent)
		)
		discount = 0
		if settings and settings.active and eligible:
			matching = sorted((row for row in settings.discount_rules if cint(row.active) and cint(row.active_channel_count) <= len(active)), key=lambda row: cint(row.active_channel_count))
			if matching:
				discount = flt(matching[-1].discount_percent)
			discount = min(discount, flt(settings.maximum_discount_percent or discount))
		self.discount_percent = discount
		if not self.active:
			self.club_status = "Заблокирован"
		elif active and eligible:
			self.club_status = "Активен"
		elif eligible:
			self.club_status = "Ожидает мессенджер"
		else:
			self.club_status = "Регистрация"

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
