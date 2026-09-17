# ruff: noqa: RUF001
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_control_center_navigation_uses_one_name():
	pages = json.loads((ROOT / "frontend/src/access-pages.json").read_text(encoding="utf-8"))
	dashboard = next(section for section in pages if section["key"] == "dashboard")
	assert dashboard["label"] == "Центр управления"
	assert dashboard["pages"][0]["label"] == "Центр управления"
	assert dashboard["pages"][1]["label"] == "I Assistant"
	assert dashboard["pages"][1]["route"] == "/assistant"


def test_control_center_uses_server_data_and_has_no_manual_refresh():
	source = (ROOT / "frontend/src/pages/DashboardPage.vue").read_text(encoding="utf-8")
	assert "raspechatka.api.dashboard.get_control_center" in source
	assert "Демо-данные" not in source
	assert "Данные обновлены" not in source
	assert ">Обновить<" not in source
	assert "Состояние бизнеса, отклонения и задачи" not in source


def test_removed_duplicate_sections_stay_out_of_control_center():
	source = (ROOT / "frontend/src/pages/DashboardPage.vue").read_text(encoding="utf-8")
	assert "Сравнение результатов" not in source
	assert "Поставки и платежи" not in source


def test_control_center_has_partner_club_and_review_data():
	page = (ROOT / "frontend/src/pages/DashboardPage.vue").read_text(encoding="utf-8")
	api = (ROOT / "raspechatka/api/dashboard.py").read_text(encoding="utf-8")
	assert 'aria-label="Партнёр"' in page
	assert "data.metrics.club" in page
	assert "data.metrics.reviews" in page
	assert '"Organization"' in api
	assert '"Sales Shift"' not in api  # Reviews use one scoped aggregate query.
	assert "`tabSales Shift`" in api


def test_assistant_is_an_explicit_placeholder():
	source = (ROOT / "frontend/src/pages/IAssistantPage.vue").read_text(encoding="utf-8")
	assert "I Assistant" in source
	assert "В разработке" in source
	assert "disabled" in source


def test_dashboard_api_obeys_scope_and_reads_finance_budget():
	source = (ROOT / "raspechatka/api/dashboard.py").read_text(encoding="utf-8")
	assert 'require_access("page.dashboard", "read")' in source
	assert "get_scope()" in source
	assert '"Finance Budget"' in source
	assert '"business_point"' in source
	assert '"business_entity"' in source
	assert '"club_members_plan"' in source
	assert '"reviews_plan"' in source
