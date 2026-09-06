import frappe
from frappe import _
from frappe.utils import cint, now_datetime


def _require_logged_in():
	if frappe.session.user == "Guest":
		frappe.throw(_("Требуется вход в систему"), frappe.PermissionError)


def _is_admin():
	return "System Manager" in set(frappe.get_roles())


def _visible_to_user(row, user, roles):
	audience = row.get("audience") or "All"
	if audience == "User":
		return row.get("audience_value") == user
	if audience == "Role":
		return row.get("audience_value") in roles
	return True


def _published_rows():
	now = now_datetime()
	rows = frappe.get_all(
		"System Announcement",
		filters={"status": "Published"},
		fields=[
			"name",
			"title",
			"message",
			"priority",
			"audience",
			"audience_value",
			"published_from",
			"published_until",
			"creation",
		],
		order_by="published_from desc, creation desc",
		limit_page_length=500,
	)
	return [
		row
		for row in rows
		if (not row.published_from or row.published_from <= now)
		and (not row.published_until or row.published_until >= now)
	]


@frappe.whitelist()
def get_notifications(limit_page_length=20):
	_require_logged_in()
	user = frappe.session.user
	roles = set(frappe.get_roles(user))
	limit_page_length = min(max(cint(limit_page_length), 1), 100)
	rows = [row for row in _published_rows() if _visible_to_user(row, user, roles)]
	read_names = set(
		frappe.get_all(
			"System Announcement Read",
			filters={"user": user, "announcement": ["in", [row.name for row in rows] or ["__none__"]]},
			pluck="announcement",
			limit_page_length=500,
		)
	)
	items = []
	for row in rows[:limit_page_length]:
		items.append(
			{
				"name": row.name,
				"title": row.title,
				"message": row.message,
				"priority": row.priority,
				"published_label": frappe.format_value(\n\t\t\t\t\trow.published_from or row.creation, {"fieldtype": "Datetime"}\n\t\t\t\t),
				"read": row.name in read_names,
			}
		)
	return {"items": items, "unread_count": sum(row.name not in read_names for row in rows)}


@frappe.whitelist(methods=["POST"])
def mark_notification_read(announcement):
	_require_logged_in()
	visible = {
		row.name
		for row in _published_rows()
		if _visible_to_user(row, frappe.session.user, set(frappe.get_roles()))
	}
	if announcement not in visible:
		frappe.throw(_("Уведомление недоступно"), frappe.PermissionError)
	if not frappe.db.exists(
		"System Announcement Read",
		{"announcement": announcement, "user": frappe.session.user},
	):
		doc = frappe.new_doc("System Announcement Read")
		doc.announcement = announcement
		doc.user = frappe.session.user
		doc.read_at = now_datetime()
		doc.insert(ignore_permissions=True)
	return {"read": True}


@frappe.whitelist()
def get_read_journal(announcement):
	if not _is_admin():
		frappe.throw(_("Недостаточно прав"), frappe.PermissionError)
	if not frappe.db.exists("System Announcement", announcement):
		frappe.throw(_("Уведомление не найдено"))
	return {
		"items": frappe.get_all(
			"System Announcement Read",
			filters={"announcement": announcement},
			fields=["user", "read_at"],
			order_by="read_at desc",
			limit_page_length=1000,
		)
	}


@frappe.whitelist(methods=["POST"])
def save_announcement(data):
	if not _is_admin():
		frappe.throw(_("Недостаточно прав"), frappe.PermissionError)
	data = frappe.parse_json(data)
	doc = (\n\t\tfrappe.get_doc("System Announcement", data["name"])\n\t\tif data.get("name")\n\t\telse frappe.new_doc("System Announcement")\n\t)
	for fieldname in (
		"title",
		"message",
		"priority",
		"audience",
		"audience_value",
		"published_from",
		"published_until",
		"status",
	):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}
