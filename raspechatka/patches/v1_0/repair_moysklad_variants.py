# ruff: noqa: RUF001

import json
from uuid import UUID

import frappe


class VariantRepairError(Exception):
	pass


def execute():
	plans = []
	failures = []

	for item in _source_product_items():
		try:
			proof = _variant_proof(item)
			if proof is None:
				continue
			plans.append(_preflight_plan(item, proof))
		except VariantRepairError as exc:
			failures.append(f"{item.name}: {exc}")

	# Cross-candidate duplicates are invisible to sibling queries until mutation,
	# so validate the complete repair set before any direct DB write.
	if not failures:
		try:
			_validate_plan_set(plans)
		except VariantRepairError as exc:
			failures.append(str(exc))

	# No mutation is allowed until every proven candidate passes validation.
	if failures:
		raise frappe.ValidationError(
			"Не удалось безопасно восстановить модификации МоегоСклада: " + "; ".join(failures[:20])
		)

	_touched_parents = set()
	for plan in plans:
		_apply_plan(plan)
		_touched_parents.add(plan["parent"].name)

	for parent_name in _touched_parents:
		has_variants = bool(
			frappe.db.exists(
				"Catalog Item",
				{"variant_of": parent_name, "item_type": "Variant", "active": 1},
			)
		)
		frappe.db.set_value(
			"Catalog Item", parent_name, "has_variants", int(has_variants), update_modified=False
		)

	for plan in plans:
		_verify_plan(plan)

	print(f"DEV-157: repaired {len(plans)} MoySklad variants across {len(_touched_parents)} parent products")


def _source_product_items():
	return frappe.get_all(
		"Catalog Item",
		filters={"item_type": "Product", "moysklad_id": ["!=", ""]},
		fields=[
			"name",
			"item_type",
			"moysklad_id",
			"moysklad_payload_json",
			"variant_of",
			"default_supplier",
		],
		limit_page_length=0,
	)


def _variant_proof(item):
	payload = _parse_payload(item.moysklad_payload_json)
	if payload is None:
		return None

	meta = payload.get("meta") or {}
	meta_type = str(meta.get("type") or "").strip().casefold()
	href = _clean_href(meta.get("href"))
	if meta_type != "variant" or "/entity/variant/" not in href.casefold():
		return None

	source_id = _uuid_from_href(href)
	stored_id = str(item.moysklad_id or "").strip().casefold()
	if not source_id or not stored_id or source_id.casefold() != stored_id:
		raise VariantRepairError("source variant UUID не совпадает с moysklad_id")

	parent_id = _source_reference_uuid(payload.get("product"), "product")
	if not parent_id:
		raise VariantRepairError("нет доказуемой ссылки на product parent")

	characteristics = _canonical_characteristics(payload.get("characteristics"))
	if not characteristics:
		raise VariantRepairError("характеристики отсутствуют или пусты")

	return {
		"parent_id": parent_id,
		"characteristics": characteristics,
		"signature": _signature(characteristics),
	}


def _preflight_plan(item, proof):
	parents = frappe.get_all(
		"Catalog Item",
		filters={"moysklad_id": proof["parent_id"]},
		fields=["name", "item_type", "active", "catalog_group", "stock_uom", "default_supplier"],
		limit_page_length=0,
	)
	if len(parents) != 1:
		raise VariantRepairError(f"parent Catalog Item должен быть ровно один, найдено {len(parents)}")
	parent = parents[0]
	if parent.item_type != "Product" or not parent.active:
		raise VariantRepairError("parent должен быть активным Catalog Item типа Product")

	if item.variant_of and item.variant_of != parent.name:
		raise VariantRepairError("обнаружен конфликтующий variant_of")

	existing_values = _variant_values(item.name)
	if existing_values and _signature(existing_values) != proof["signature"]:
		raise VariantRepairError("существующие variant_values расходятся с source characteristics")

	for sibling in frappe.get_all(
		"Catalog Item",
		filters={"variant_of": parent.name, "name": ["!=", item.name]},
		fields=["name"],
		limit_page_length=0,
	):
		sibling_values = _variant_values(sibling.name)
		if sibling_values and _signature(sibling_values) == proof["signature"]:
			raise VariantRepairError("найдена конфликтующая canonical variant signature")

	return {
		"item": item,
		"parent": parent,
		"characteristics": proof["characteristics"],
		"signature": proof["signature"],
		"existing_values": existing_values,
	}


def _validate_plan_set(plans):
	seen = {}
	for plan in plans:
		key = (plan["parent"].name, plan["signature"])
		previous = seen.get(key)
		if previous:
			raise VariantRepairError(
				f"кандидаты {previous} и {plan['item'].name} имеют одинаковую variant signature"
			)
		seen[key] = plan["item"].name


def _apply_plan(plan):
	item = plan["item"]
	parent = plan["parent"]
	values = {
		"item_type": "Variant",
		"variant_of": parent.name,
		"catalog_group": parent.catalog_group,
		"stock_uom": parent.stock_uom,
	}
	if not item.default_supplier and parent.default_supplier:
		values["default_supplier"] = parent.default_supplier

	# Direct DB writes intentionally bypass normal type immutability while
	# retaining the existing Catalog Item name and all linked records.
	frappe.db.set_value("Catalog Item", item.name, values, update_modified=False)

	if plan["existing_values"]:
		return

	for idx, characteristic in enumerate(plan["characteristics"], start=1):
		frappe.get_doc(
			{
				"doctype": "Catalog Variant Value",
				"parent": item.name,
				"parenttype": "Catalog Item",
				"parentfield": "variant_values",
				"idx": idx,
				"attribute_name": characteristic["attribute_name"],
				"attribute_value": characteristic["attribute_value"],
			}
		).db_insert()


def _verify_plan(plan):
	item = plan["item"]
	parent = plan["parent"]
	stored = frappe.db.get_value(
		"Catalog Item",
		item.name,
		["item_type", "variant_of", "catalog_group", "stock_uom", "default_supplier"],
		as_dict=True,
	)
	expected_supplier = item.default_supplier or parent.default_supplier
	if (
		not stored
		or stored.item_type != "Variant"
		or stored.variant_of != parent.name
		or stored.catalog_group != parent.catalog_group
		or stored.stock_uom != parent.stock_uom
		or stored.default_supplier != expected_supplier
	):
		raise frappe.ValidationError(f"DEV-157 postcondition failed for Catalog Item {item.name}")
	if _signature(_variant_values(item.name)) != plan["signature"]:
		raise frappe.ValidationError(
			f"DEV-157 variant values postcondition failed for Catalog Item {item.name}"
		)


def _variant_values(item_name):
	if not frappe.db.table_exists("Catalog Variant Value"):
		raise VariantRepairError("Catalog Variant Value недоступен")
	return frappe.get_all(
		"Catalog Variant Value",
		filters={"parent": item_name, "parenttype": "Catalog Item", "parentfield": "variant_values"},
		fields=["attribute_name", "attribute_value", "idx"],
		order_by="idx asc",
	)


def _canonical_characteristics(rows):
	if not isinstance(rows, list):
		raise VariantRepairError("characteristics имеют неверный формат")

	result = []
	names = set()
	for row in rows:
		if not isinstance(row, dict):
			raise VariantRepairError("characteristic имеет неверный формат")
		name = _normalize(row.get("name") or row.get("id"))[:140]
		value = _normalize(_payload_value(row.get("value")))[:140]
		if not name or not value:
			raise VariantRepairError("characteristic должен иметь имя и значение")
		name_key = name.casefold()
		if name_key in names:
			raise VariantRepairError("имя характеристики повторяется")
		names.add(name_key)
		result.append({"attribute_name": name, "attribute_value": value})

	return result


def _signature(rows):
	try:
		pairs = [
			(
				_normalize(
					row.attribute_name if hasattr(row, "attribute_name") else row["attribute_name"]
				).casefold(),
				_normalize(
					row.attribute_value if hasattr(row, "attribute_value") else row["attribute_value"]
				).casefold(),
			)
			for row in rows
		]
	except (KeyError, TypeError, AttributeError, ValueError) as exc:
		raise VariantRepairError("variant_values имеют неверный формат") from exc
	if not pairs or len({name for name, _value in pairs}) != len(pairs):
		raise VariantRepairError("variant_values имеют повторяющиеся параметры")
	return tuple(sorted(pairs))


def _source_reference_uuid(reference, expected_type):
	if not isinstance(reference, dict):
		return None
	meta = reference.get("meta") or {}
	ref_type = str(meta.get("type") or reference.get("type") or "").strip().casefold()
	href = _clean_href(meta.get("href") or reference.get("href"))
	if ref_type != expected_type or f"/entity/{expected_type}/" not in href.casefold():
		return None
	return _uuid_from_href(href)


def _uuid_from_href(href):
	value = _clean_href(href).rsplit("/", 1)[-1]
	try:
		return str(UUID(value))
	except (ValueError, AttributeError):
		return None


def _clean_href(value):
	return str(value or "").split("?", 1)[0].rstrip("/")


def _parse_payload(value):
	try:
		payload = json.loads(value) if value else None
	except (TypeError, ValueError):
		return None
	return payload if isinstance(payload, dict) else None


def _payload_value(value):
	if isinstance(value, dict):
		return (
			value.get("name")
			or value.get("value")
			or value.get("id")
			or json.dumps(value, ensure_ascii=False, separators=(",", ":"))
		)
	if isinstance(value, list):
		return ", ".join(str(_payload_value(item)) for item in value)
	return value


def _normalize(value):
	return " ".join(str(value or "").split())
