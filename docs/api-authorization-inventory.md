# External API authorization inventory

This inventory covers every `frappe.whitelist` endpoint in `raspechatka` at DEV-072. The authenticated
browser boundary uses `page.*` access areas. `get_scope()` is applied to list/options/dashboard queries;
document endpoints authorize the persisted object before accepting client-controlled scope fields.

| Endpoint(s) | Page permission / action | Scope | Object-level check |
|---|---|---|---|
| `access.get_access_settings` | `page.references.access` / read | Network | Network-admin guard |
| `access.create_work_role`, `rename_work_role`, `delete_work_role`, `save_access_settings` | `page.references.access` / admin | Network | Protected/base-role validation |
| `api.users.*` | `page.references.users` / admin | Network, Partner, Entity, Points | Existing and proposed profile must remain inside caller scope; linked employee checked |
| `api.dashboard.get_control_center` | `page.dashboard` / read | caller points/entities | Scoped aggregate filters |
| `api.sales.get_sales_options`, `get_points_overview` | `page.sales.overview` / read | caller points/entities | Scoped options/aggregates |
| `api.sales.get_shifts`, `get_shift` | `page.sales.shifts` / read | caller points/entities | Persisted shift point/entity checked |
| `api.sales.get_receipts`, `get_receipt` | `page.sales.receipts` / read | caller points/entities | Persisted receipt point/entity checked |
| `api.sales.get_cash_movements` | `page.sales.cash` / read | caller points/entities | Scoped query |
| `api.sales.get_cashier_actions` | `page.sales.audit` / read | caller points/entities | Scoped query |
| `api.sales.get_connections`, `provision_connection` | `page.sales.integration` / read, admin | caller points | Requested/persisted connection point checked |
| `api.sales.push_batch` | POS token | authenticated POS point | Connection point is authoritative |
| `api.receipt_search.search_receipts` | POS token | authenticated POS point | Every receipt/shift/payment query pins `connection.business_point` |
| `api.pos_device.*`, `api.pos_v2.*` | POS token | authenticated POS point | Connection point is authoritative; payload point is ignored |
| `api.pos.get_bootstrap`, `push_events` | authenticated user/POS compatibility | caller or connection point | Delegates to scoped POS services |
| `api.finance.get_finance_options`, `get_payments`, `get_payment` | `page.finance.payments` / read | caller points/entities | Scoped query; persisted transaction checked |
| `api.finance.save_payment`, `cancel_payment` | `page.finance.payments` / write | caller points/entities | Persisted transaction checked before payload; proposed entity/point and linked account/supplier checked |
| `api.finance.get_cash_expense`, `create_cash_expense` | `page.finance.payments` / create | caller points/entities | Entity, point and supplier scope checked before write |
| `api.finance.get_payment_calendar`, `save_plan_item`, `delete_plan_item` | `page.finance.calendar` / read, create/write | caller points/entities | Entity/point and persisted plan item checked |
| `api.finance.get_financial_report` | `page.finance.report` / read | caller points/entities | Scoped aggregate filters |
| `api.finance.get_budget`, `save_budget` | `page.finance.planning` / read, create/write | caller points/entities | Entity/point checked |
| `api.finance.get_settlements` | `page.finance.settlements` / read | caller entities | Scoped aggregate filters |
| `api.finance.get_profitability` | `page.finance.profitability` / read | caller entities | Scoped aggregate filters |
| `api.finance.get_finance_settings`, article/rule/reprocess methods | `page.finance.settings` / admin | caller entities where applicable | Existing rule/operation and account entity checked |
| `api.tochka.*` authenticated methods | `page.finance.bank` / read/write | caller entities | Connection/account entity checked |
| `api.tochka.oauth_callback` | OAuth state | state-bound entity | Signed/one-time OAuth state |
| `api.clients.get_clients`, `get_client`, `save_client`, `lookup_client`, `record_purchase` | `page.clients.list` / read/write | clients registered/purchased at caller points | Client visibility plus requested point check |
| `api.clients.get_client_options` | `page.clients.list` / read | caller points | Points filtered; Network-wide marketing options withheld from scoped callers |
| `api.clients.get_club_dashboard` | `page.clients.club` / read | visible clients and caller points | Scoped counts; Network-only campaign totals withheld |
| `api.clients.get_loyalty_settings`, `save_loyalty_settings`, `run_loyalty_discount_recalculation` | `page.clients.club` / read/write | Network-wide | Explicit Network-only guard; bulk recalculation updates derived loyalty fields only |
| `api.clients.get_marketing_records`, `get_marketing_record`, `save_marketing_record` | matching `page.clients.{segments,campaigns,promo_codes,calendar}` / read/write | Network-wide | Explicit Network-only guard; segment member helper still intersects visible clients |
| `api.clients.club_gateway`, public club/config/register/channel methods | session/link/webhook token | token client | Token resolves the client; secrets are not returned |
| `api.club_shadow.status`, `configure` | `page.clients.club` / admin | Network | Network configuration guard |
| `api.club_shadow.receive` | webhook secret | configured integration | Signature/secret and idempotency checks |
| `api.frontend.*` catalog methods | `page.catalog` / read/create/write | Network-wide catalog | Existing catalog object checked for mutations |
| `api.references.get_reference_list`, `get_reference_detail`, `save_reference`, archive/delete | page matching reference / read/create/write/delete | caller points/entities or Network reference | `_scope_filters` / `_ensure_scoped_name`; existing object checked before mutation |
| `api.references` bank/supplier/storage child methods | matching entity/supplier/warehouse page / create/write | caller entities/points | Parent object checked before child payload |
| `api.references.get_reference_options` | per-option page read | caller points/entities | Each option family independently permission- and scope-filtered |
| `api.references.get_view_preference`, `save_view_preference` | authenticated user | current user only | Preference key is stored per session user |
| `api.list_filters.*` | page matching requested DocType / read | caller scope | DocType allowlist plus scope filters |
| `api.team` employee methods | `page.team.employees` / read/write | caller entities/points | Existing employee and assigned points checked |
| `api.team.get_schedule`, `save_schedule` | `page.team.schedule` / read/write | caller entities/points | Employee/entity/point filters |
| `api.team` motivation/game methods | `page.team.bonuses` / read/write | caller entities/points | Scoped employee/shift aggregates |
| `api.team.calculate_payroll` | `page.team.payroll` / read/write | caller entities | Entity checked |
| `api.team` payroll settings methods | `page.team.settings` / read/write | caller entities | Policy/component ownership checked |
| `api.team.get_hr_overview`, `api.hr_documents` HR methods | `page.team.hr` / read/write | caller entities/employees | Employee/entity and persisted document checked |
| `api.procurement.*` | `page.warehouse.purchase_orders` / create | caller points/entities | Requested point/entity checked |
| `api.warehouse.*`, `api.warehouse_documents.*` | matching warehouse page / read/write | caller points/entities | Existing document checked before payload and transition |
| `api.warehouse_reports.*` | matching balances/turnover/movements page / read | caller points | Scoped warehouse/point query |
| `stock_reconciliation.rebuild_operational_balances`, `warehouse_performance.*` | warehouse admin/diagnostic permission | Network/admin | Explicit privileged maintenance guard |
| `api.moysklad.*`, `api.moysklad_sales.*`, `api.moysklad_stock.*`, `api.moysklad_stock_history.*` | `page.references.moysklad` / admin | configured integration scope | Mapping entity/point checked; provider IDs are not authority |
| `api.supplier_settlements.get_payment_context`, `link_payment`, `unlink_payment` | `page.warehouse.purchase_orders` / read/write | caller points/entities | Persisted order and payment checked; entity/supplier relation enforced |
| `api.supplier_settlements.get_supplier_debt` | `page.finance.settlements` / read | caller points/entities | Scoped order aggregate |
| `api.notifications.*` | authenticated user; announcement write is privileged | current user / allowed audience | Read journal keyed by session user |

Guest endpoints are limited to POS device tokens, OAuth callbacks, club session/link tokens, and configured
webhook secrets. `receipt_search.py` is the reference implementation: a point supplied by the client is never
accepted as authorization context.
