import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def source(path):
	return (ROOT / path).read_text(encoding="utf-8")


def doctype(name):
	path = ROOT / "raspechatka/raspechatka_os/doctype" / name / f"{name}.json"
	return json.loads(path.read_text(encoding="utf-8"))


def fieldnames(schema):
	return {row["fieldname"] for row in schema["fields"]}


def test_removed_fields_are_absent_from_the_user_model():
	assert "email" not in fieldnames(doctype("organization"))
	assert "registration_status" not in fieldnames(doctype("business_entity"))
	assert "notes" not in fieldnames(doctype("raspechatka_user_profile"))
	point_fields = fieldnames(doctype("business_point"))
	assert (
		not {
			"card_bank_account",
			"qr_bank_account",
			"allow_free_price",
			"allow_discounts",
			"max_discount_percent",
			"allow_remove_cart_item",
			"accepts_cash",
			"accepts_card",
			"accepts_qr",
		}
		& point_fields
	)


def test_archiving_is_the_only_visible_lifecycle_for_core_references():
	master = source("frontend/src/pages/MasterDataPage.vue")
	users = source("frontend/src/pages/UsersPage.vue")
	references = source("frontend/src/pages/ReferencesPage.vue")
	assert "reference !== 'organizations'" in master
	assert "canAdmin && reference !== 'organizations'" in master
	assert "Пользователь активен" not in users
	assert "form.notes" not in users
	assert 'v-model="form.active"' not in references


def test_point_contacts_timezone_and_working_hours_round_trip_contract():
	point = doctype("business_point")
	fields = fieldnames(point)
	assert {
		"telegram",
		"max_messenger",
		"vk",
		"whatsapp",
		"yandex_reviews_url",
		"twogis_reviews_url",
	} <= fields
	timezone = next(row for row in point["fields"] if row["fieldname"] == "timezone")
	assert timezone["fieldtype"] == "Select"
	assert "Europe/Moscow" in timezone["options"]
	ui = source("frontend/src/pages/ReferencesPage.vue")
	assert "String(day.opens_at).slice(0, 5)" in ui
	assert "String(day.closes_at).slice(0, 5)" in ui
	api = source("raspechatka/api/references.py")
	assert 'if reference == "points" and "working_hours" in data:' in api
	assert '"opens_at": row.get("opens_at")' in api


def test_pos_rules_have_one_network_wide_source_of_truth():
	settings = doctype("pos_sales_settings")
	assert settings["issingle"] == 1
	assert fieldnames(settings) >= {
		"allow_free_price",
		"allow_discounts",
		"max_discount_percent",
		"allow_remove_cart_item",
		"accepts_cash",
		"accepts_card",
		"accepts_qr",
	}
	assert "get_pos_sales_rules()" in source("raspechatka/api/pos.py")
	assert "get_pos_sales_rules()" in source("raspechatka/api/pos_device.py")
	sales = source("raspechatka/api/sales.py")
	assert 'if not get_scope()["global"]:' in sales
	assert "Общие настройки продаж" in source("frontend/src/pages/SalesPage.vue")


def test_legacy_values_are_not_randomly_selected_during_migration():
	patch = source("raspechatka/patches/v1_0/initialize_pos_sales_settings.py")
	assert "DEFAULT_POS_SALES_SETTINGS" in patch
	assert "Business Point" not in patch
