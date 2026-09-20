import frappe
from frappe import _


SELLABLE_ITEM_TYPES = {"Product", "Service", "Variant", "Bundle"}


def get_pos_upsell_config():
	rules = []
	for rule in frappe.get_all(
		"POS Upsell Rule",
		fields=["name", "trigger_item", "enabled"],
		order_by="trigger_item asc",
		limit_page_length=0,
	):
		rules.append(
			{
				"name": rule.name,
				"trigger_item": rule.trigger_item,
				"enabled": bool(rule.enabled),
				"candidates": [
					{
						"item": row.item,
						"cashier_phrase": row.cashier_phrase or "",
						"idx": row.idx,
					}
					for row in frappe.get_all(
						"POS Upsell Candidate",
						filters={"parent": rule.name, "parenttype": "POS Upsell Rule"},
						fields=["item", "cashier_phrase", "idx"],
						order_by="idx asc",
						limit_page_length=0,
					)
				],
			}
		)
	return {"rules": rules, "catalog_items": _catalog_items()}


def save_pos_upsell_rules(snapshot):
	rules = _validate_snapshot(snapshot)
	existing = {
		row.name: row
		for row in frappe.get_all(
			"POS Upsell Rule",
			fields=["name"],
			limit_page_length=0,
		)
	}
	known_names = set(existing)
	seen_names = set()
	for rule in rules:
		name = rule.get("name")
		if name:
			if name not in known_names:
				frappe.throw(_("Правило дополнительных продаж не найдено"), frappe.ValidationError)
			if name in seen_names:
				frappe.throw(_("Правило дополнительных продаж указано дважды"), frappe.ValidationError)
			seen_names.add(name)

	savepoint = "pos_upsell_rules_reconcile"
	frappe.db.savepoint(savepoint)
	try:
		for name in known_names - seen_names:
			frappe.delete_doc("POS Upsell Rule", name, ignore_permissions=True)

		for rule_data in rules:
			name = rule_data.get("name")
			doc = frappe.get_doc("POS Upsell Rule", name) if name else frappe.new_doc("POS Upsell Rule")
			doc.trigger_item = rule_data["trigger_item"]
			doc.enabled = int(rule_data["enabled"])
			doc.set("candidates", [])
			for candidate in rule_data["candidates"]:
				doc.append(
					"candidates",
					{
						"item": candidate["item"],
						"cashier_phrase": candidate["cashier_phrase"],
					},
				)
			doc.save(ignore_permissions=True)
	except Exception:
		frappe.db.rollback(save_point=savepoint)
		raise

	return get_pos_upsell_config()


def _validate_snapshot(snapshot):
	if isinstance(snapshot, dict):
		rules = snapshot.get("rules")
	else:
		rules = snapshot
	if not isinstance(rules, list):
		frappe.throw(_("Ожидается полный snapshot правил дополнительных продаж"), frappe.ValidationError)

	validated = []
	seen_triggers = set()
	for raw_rule in rules:
		if not isinstance(raw_rule, dict):
			frappe.throw(_("Каждое правило должно быть объектом"), frappe.ValidationError)
		trigger = str(raw_rule.get("trigger_item") or "").strip()
		if not trigger:
			frappe.throw(_("Укажите основную позицию правила"), frappe.ValidationError)
		if trigger in seen_triggers:
			frappe.throw(_("Для основной позиции допускается только одно правило"), frappe.ValidationError)
		seen_triggers.add(trigger)

		candidates = raw_rule.get("candidates")
		if not isinstance(candidates, list):
			frappe.throw(_("Кандидаты правила должны быть списком"), frappe.ValidationError)
		enabled = _as_bool(raw_rule.get("enabled", 1))
		if enabled and not candidates:
			frappe.throw(_("Включённое правило должно содержать кандидата"), frappe.ValidationError)

		trigger_row = _require_sellable(trigger, _("основной позиции"))
		seen_targets = set()
		validated_candidates = []
		for raw_candidate in candidates:
			if not isinstance(raw_candidate, dict):
				frappe.throw(_("Кандидат должен быть объектом"), frappe.ValidationError)
			target = str(raw_candidate.get("item") or "").strip()
			if not target:
				frappe.throw(_("Укажите позицию-кандидат"), frappe.ValidationError)
			if target == trigger:
				frappe.throw(_("Основная позиция не может рекомендовать себя"), frappe.ValidationError)
			if target in seen_targets:
				frappe.throw(_("Позиция-кандидат не должна повторяться"), frappe.ValidationError)
			seen_targets.add(target)
			_require_sellable(target, _("позиции-кандидата"))
			validated_candidates.append(
				{
					"item": target,
					"cashier_phrase": str(raw_candidate.get("cashier_phrase") or "").strip(),
				}
			)

		validated.append(
			{
				"name": str(raw_rule.get("name") or "").strip() or None,
				"trigger_item": trigger_row.name,
				"enabled": enabled,
				"candidates": validated_candidates,
			}
		)
	return validated


def _catalog_items():
	rows = frappe.get_all(
		"Catalog Item",
		filters={"active": 1, "item_type": ["in", sorted(SELLABLE_ITEM_TYPES)]},
		fields=["name", "item_name", "item_type", "has_variants"],
		order_by="item_name asc",
		limit_page_length=0,
	)
	return [
		{"name": row.name, "item_name": row.item_name, "item_type": row.item_type}
		for row in rows
		if not (row.item_type == "Product" and row.has_variants)
	]


def _require_sellable(name, label):
	row = frappe.db.get_value(
		"Catalog Item",
		name,
		["name", "item_name", "item_type", "active", "has_variants"],
		as_dict=True,
	)
	if not row or not row.active:
		frappe.throw(_("{0} должна быть активной позицией каталога").format(label), frappe.ValidationError)
	if row.item_type not in SELLABLE_ITEM_TYPES:
		frappe.throw(_("{0} должна быть продаваемой позицией каталога").format(label), frappe.ValidationError)
	if row.item_type == "Product" and row.has_variants:
		frappe.throw(
			_("{0}: основной товар с активными модификациями нельзя использовать как отдельный SKU").format(label),
			frappe.ValidationError,
		)
	return row


def _as_bool(value):
	if isinstance(value, bool):
		return value
	try:
		return bool(int(value or 0))
	except (TypeError, ValueError):
		return str(value).strip().casefold() in {"1", "true", "yes", "on"}
