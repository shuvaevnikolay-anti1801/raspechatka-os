import hashlib
import json
from urllib.parse import urljoin

import frappe
from frappe import _
from frappe.utils import flt, now_datetime

from raspechatka.access import require_access
from raspechatka.api.moysklad import API_BASE, PAGE_SIZE, _money, _ref_id, _request


@frappe.whitelist()
def get_opening_stock_settings():
    require_access("settings.access", "admin")
    settings = frappe.get_single("MoySklad Settings")
    return {
        "status": settings.opening_stock_status or "Idle",
        "preview_token": settings.opening_stock_preview_token,
        "preview": _loads(settings.opening_stock_preview_json),
        "documents": _loads(settings.opening_stock_documents_json) or [],
        "imported_at": settings.opening_stock_imported_at,
        "error": settings.opening_stock_error,
        "warehouses": frappe.get_all(
            "Catalog Warehouse",
            filters={"active": 1},
            fields=[
                "name",
                "warehouse_name",
                "business_point",
                "moysklad_store_id",
                "moysklad_store_name",
            ],
            order_by="warehouse_name asc",
        ),
    }


@frappe.whitelist(methods=["POST"])
def discover_stock_sources():
    require_access("settings.access", "admin")
    settings = frappe.get_single("MoySklad Settings")
    rows = _paged_rows(settings, "entity/store")
    return {
        "stores": [
            {
                "id": row.get("id"),
                "name": row.get("name"),
                "archived": bool(row.get("archived")),
            }
            for row in rows
            if row.get("id")
        ]
    }


@frappe.whitelist(methods=["POST"])
def save_stock_mappings(data):
    require_access("settings.access", "admin")
    mappings = (frappe.parse_json(data) or {}).get("mappings") or []
    by_warehouse = {row.get("warehouse"): row for row in mappings}
    used_sources = set()

    for warehouse in frappe.get_all(
        "Catalog Warehouse",
        filters={"active": 1},
        fields=["name"],
    ):
        mapping = by_warehouse.get(warehouse.name) or {}
        source_id = str(mapping.get("source_id") or "").strip()
        source_name = str(mapping.get("source_name") or "").strip()
        if source_id and source_id in used_sources:
            frappe.throw(_("Один склад МоегоСклада нельзя назначить нескольким складам ОС."))
        if source_id:
            used_sources.add(source_id)
        frappe.db.set_value(
            "Catalog Warehouse",
            warehouse.name,
            {
                "moysklad_store_id": source_id or None,
                "moysklad_store_name": source_name or None,
            },
        )

    settings = frappe.get_single("MoySklad Settings")
    settings.opening_stock_status = "Idle"
    settings.opening_stock_preview_token = None
    settings.opening_stock_preview_json = None
    settings.opening_stock_error = None
    settings.save(ignore_permissions=True)
    return get_opening_stock_settings()


@frappe.whitelist(methods=["POST"])
def preview_opening_stock():
    require_access("settings.access", "admin")
    settings = frappe.get_single("MoySklad Settings")
    if settings.opening_stock_status == "Imported":
        frappe.throw(_("Начальные остатки уже перенесены."))

    snapshot = _build_snapshot(settings)
    token = _snapshot_token(snapshot)
    settings.opening_stock_status = "Previewed"
    settings.opening_stock_preview_token = token
    settings.opening_stock_preview_json = json.dumps(
        snapshot,
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    )
    settings.opening_stock_error = None
    settings.save(ignore_permissions=True)
    return {**snapshot["summary"], "preview_token": token, "warehouses": snapshot["warehouses"]}


@frappe.whitelist(methods=["POST"])
def import_opening_stock(preview_token):
    require_access("settings.access", "admin")
    settings = frappe.get_single("MoySklad Settings")
    if settings.opening_stock_status == "Imported":
        return {
            "imported": False,
            "duplicate": True,
            "documents": _loads(settings.opening_stock_documents_json) or [],
        }
    if (
        not preview_token
        or preview_token != settings.opening_stock_preview_token
        or settings.opening_stock_status != "Previewed"
    ):
        frappe.throw(_("Сначала выполните новую проверку начальных остатков."))

    verified = _loads(settings.opening_stock_preview_json)
    current = _build_snapshot(settings)
    if _snapshot_token(current) != preview_token:
        frappe.throw(
            _(
                "Остатки или сопоставления изменились после проверки. "
                "Повторите предварительный просмотр."
            )
        )

    savepoint = "moysklad_opening_stock"
    frappe.db.savepoint(savepoint)
    try:
        documents = _create_inventories(verified, preview_token)
        settings.reload()
        settings.opening_stock_status = "Imported"
        settings.opening_stock_documents_json = json.dumps(
            documents,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        settings.opening_stock_imported_at = now_datetime()
        settings.opening_stock_error = None
        settings.save(ignore_permissions=True)
        return {"imported": True, "duplicate": False, "documents": documents}
    except Exception as exc:
        frappe.db.rollback(save_point=savepoint)
        settings = frappe.get_single("MoySklad Settings")
        settings.opening_stock_status = "Error"
        settings.opening_stock_error = str(exc)[:2000]
        settings.save(ignore_permissions=True)
        raise


def _build_snapshot(settings):
    mappings = frappe.get_all(
        "Catalog Warehouse",
        filters={"active": 1},
        fields=[
            "name",
            "warehouse_name",
            "business_point",
            "moysklad_store_id",
            "moysklad_store_name",
        ],
        order_by="name asc",
    )
    if not mappings:
        frappe.throw(_("В ОС нет активных складов."))
    missing_mapping = [row.warehouse_name for row in mappings if not row.moysklad_store_id]
    if missing_mapping:
        frappe.throw(
            _("Не сопоставлены склады: {0}.").format(", ".join(missing_mapping))
        )

    result = []
    missing_items = []
    invalid_rows = []
    total_quantity = 0
    total_value = 0

    for mapping in mappings:
        _assert_empty_warehouse(mapping.name)
        source_href = urljoin(API_BASE, f"entity/store/{mapping.moysklad_store_id}")
        source_rows = _paged_rows(
            settings,
            "report/stock/all",
            {"filter": f"store={source_href}", "stockMode": "all"},
        )
        lines = []
        for source in source_rows:
            quantity = flt(source.get("stock"))
            if abs(quantity) <= 0.000001:
                continue
            source_item_id = _ref_id(source.get("assortment") or source.get("meta"))
            item = frappe.db.get_value(
                "Catalog Item",
                {"moysklad_id": source_item_id},
                "name",
            )
            label = source.get("name") or source_item_id or _("Неизвестный товар")
            if not item:
                missing_items.append(label)
                continue
            rate = _money(source.get("price") or source.get("buyPrice"))
            if quantity < 0 or rate <= 0:
                invalid_rows.append(
                    {
                        "warehouse": mapping.warehouse_name,
                        "item": label,
                        "quantity": quantity,
                        "rate": rate,
                    }
                )
                continue
            lines.append(
                {
                    "source_item_id": source_item_id,
                    "item": item,
                    "item_name": label,
                    "quantity": quantity,
                    "valuation_rate": rate,
                }
            )
            total_quantity += quantity
            total_value += quantity * rate
        result.append(
            {
                "warehouse": mapping.name,
                "warehouse_name": mapping.warehouse_name,
                "business_point": mapping.business_point,
                "source_store_id": mapping.moysklad_store_id,
                "source_store_name": mapping.moysklad_store_name,
                "lines": sorted(lines, key=lambda row: row["item"]),
            }
        )

    if missing_items:
        frappe.throw(
            _(
                "Нельзя переносить остатки: {0} позиций не сопоставлены с каталогом ОС. "
                "Сначала повторите перенос каталога. Примеры: {1}"
            ).format(len(missing_items), ", ".join(missing_items[:10]))
        )
    if invalid_rows:
        examples = ", ".join(
            f"{row['item']} ({row['quantity']} шт., {row['rate']} ₽)"
            for row in invalid_rows[:10]
        )
        frappe.throw(
            _(
                "В исходных остатках есть отрицательное количество или нулевая "
                "себестоимость: {0}"
            ).format(examples)
        )

    summary = {
        "warehouse_count": len(result),
        "line_count": sum(len(row["lines"]) for row in result),
        "total_quantity": total_quantity,
        "total_value": total_value,
    }
    return {"version": 1, "summary": summary, "warehouses": result}


def _create_inventories(snapshot, preview_token):
    documents = []
    for warehouse in snapshot.get("warehouses") or []:
        if not warehouse.get("lines"):
            continue
        frappe.db.sql(
            "select name from `tabCatalog Warehouse` where name=%s for update",
            warehouse["warehouse"],
        )
        _assert_empty_warehouse(warehouse["warehouse"])
        external_id = (
            f"moysklad-opening:{warehouse['source_store_id']}:{preview_token[:16]}"
        )
        existing = frappe.db.get_value(
            "Stock Inventory",
            {"external_id": external_id},
            "name",
        )
        if existing:
            documents.append(existing)
            continue
        business_entity = frappe.db.get_value(
            "Business Point",
            warehouse["business_point"],
            "business_entity",
        )
        doc = frappe.new_doc("Stock Inventory")
        doc.business_entity = business_entity
        doc.business_point = warehouse["business_point"]
        doc.warehouse = warehouse["warehouse"]
        doc.posting_datetime = now_datetime()
        doc.reason = _("Начальные остатки из МоегоСклада")
        doc.remarks = _(
            "Одноразовый перенос проверенного снимка. Исторические документы не переносились."
        )
        doc.source = "MoySklad Opening Balance"
        doc.external_id = external_id
        for line in warehouse["lines"]:
            doc.append(
                "items",
                {
                    "item": line["item"],
                    "counted_quantity": line["quantity"],
                    "valuation_rate": line["valuation_rate"],
                },
            )
        doc.insert(ignore_permissions=True)
        doc.submit()
        documents.append(doc.name)
    return documents


def _assert_empty_warehouse(warehouse):
    if frappe.db.exists("Stock Ledger Entry", {"warehouse": warehouse}):
        frappe.throw(
            _(
                "На складе {0} уже есть движения. Начальные остатки можно "
                "перенести только до начала складских операций."
            ).format(warehouse)
        )


def _paged_rows(settings, endpoint, params=None):
    rows = []
    offset = 0
    while True:
        page_params = {
            **(params or {}),
            "limit": PAGE_SIZE,
            "offset": offset,
        }
        payload = _request(settings, endpoint, params=page_params)
        page = payload.get("rows") or []
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += len(page)


def _snapshot_token(snapshot):
    canonical = json.dumps(
        snapshot,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _loads(value):
    try:
        return json.loads(value) if value else None
    except (TypeError, ValueError):
        return None
