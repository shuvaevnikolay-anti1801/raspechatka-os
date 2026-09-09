import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_control_center_navigation_uses_one_name():
    pages = json.loads((ROOT / "frontend/src/access-pages.json").read_text(encoding="utf-8"))
    dashboard = next(section for section in pages if section["key"] == "dashboard")
    assert dashboard["label"] == "Центр управления"
    assert dashboard["pages"][0]["label"] == "Центр управления"


def test_control_center_uses_server_data_and_has_no_manual_refresh():
    source = (ROOT / "frontend/src/pages/DashboardPage.vue").read_text(encoding="utf-8")
    assert "raspechatka.api.dashboard.get_control_center" in source
    assert "Демо-данные" not in source
    assert "Данные обновлены" not in source
    assert ">Обновить<" not in source
    assert "Состояние бизнеса, отклонения и задачи" not in source


def test_points_section_is_always_rendered():
    source = (ROOT / "frontend/src/pages/DashboardPage.vue").read_text(encoding="utf-8")
    assert "Сравнение результатов" in source
    assert "data.points.length > 1" not in source


def test_dashboard_api_obeys_scope_and_reads_finance_budget():
    source = (ROOT / "raspechatka/api/dashboard.py").read_text(encoding="utf-8")
    assert 'require_access("page.dashboard", "read")' in source
    assert "get_scope()" in source
    assert '"Finance Budget"' in source
    assert '"business_point"' in source
    assert '"business_entity"' in source
