# DEV-168 — POS document synchronization reliability + Web OS internal orders

Branch: `codex/dev-168-pos-documents-reliability`  
Base: `version-16@3566a5f119676ab6539d29336d847ae631710c2e`

## Why this DEV exists

Real POS acceptance after DEV-164/165 found a common failure pattern:

- orders created/updated in Windows POS do not appear in Web OS → Sales → Orders;
- supplier Purchase Orders arrive from OS to POS, but POS receiving disappears optimistically, then returns after refresh; no canonical Stock Receipt is created;
- POS “Списать брак” does not produce a visible canonical submitted Stock Write Off;
- POS “Потребность точки” has no Web OS destination the user can see.

The repository already contains most individual handlers. The problem is not “implement every document from scratch”; the goal is to make the existing POS outbox contract observable, fault-isolated and proven end-to-end, then expose the existing Point Supply Request model as “Внутренние заказы”.

## Current verified architecture

### Client/outbox

`pos/src/main/database.ts` already queues:
- `order.created` / `order.updated`;
- `stock.write_off.requested`;
- `stock.receipt.requested`;
- `point.supply.requested`.

Order and warehouse IPC handlers already obtain the authenticated cashier from `assertCashierAccess()` and attach trusted cashier evidence.

`sync.ts` already:
- refreshes bootstrap;
- pushes outbox;
- marks accepted IDs sent;
- does read-after-write bootstrap after accepted events;
- separates master-data and document-queue status.

### Server

`raspechatka.api.pos_v2.push_events` already routes:
- order events to canonical POS Order ingestion;
- write-off to `_ingest_stock_write_off`;
- supply need to `_ingest_supply_request`;
- receipt to `_ingest_stock_receipt`.

Canonical handlers already point-scope data and use server-owned Purchase Order/warehouse/item data.

### Critical reliability gap

The current `push_events` request processes up to 100 events in one request and wraps the whole loop in one exception boundary. One invalid/rejected event raises and prevents the client from receiving accepted IDs for the rest of that batch. This can let one stale/poisoned outbox item block otherwise valid POS→OS documents.

Current tests mostly mock handlers/stores. They prove routing/contracts but not a true Frappe round trip through real DocTypes and transaction validation. Production acceptance has contradicted the mocked happy path, so this DEV requires real integration-level regression tests.

### Supply requests

Do NOT create another storage model.

Existing canonical DocType `Point Supply Request` already contains:
- request date;
- business entity / point / warehouse;
- item + item_name;
- quantity;
- status;
- requested_by_employee / requested_by;
- comment;
- unique `source_pos_event`.

`point.supply.requested` already creates it. The requested Web OS “Внутренние заказы” page must be a read-only first UI over this existing DocType.

## Global invariants

- No changes to payment/fiscal providers, TransactionEngine, fiscal recovery or money execution.
- POS event IDs remain idempotency/deduplication keys.
- Never mark a rejected event sent.
- Never blindly retry an external event whose server outcome is unknown; server handlers must be idempotent and each accepted ID must mean the canonical transaction completed.
- One bad operational event must not prevent independent valid events from being accepted.
- Do not trust point, warehouse, supplier, rate, cashier or employee data from renderer/client when a server-owned relation can be derived from authenticated POS connection/current canonical document.
- New Web OS page follows `docs/access-control-contract.md` and `docs/list-workspace.md`.
- New Web OS page is deny-by-default for ordinary roles through a new unique `page.*` area.
- DEV-168 must not restyle or restructure `WorkPage.tsx`; DEV-167 owns that file/UX in parallel.

## Stage DEV-168 (1) — isolate poisoned outbox events and expose exact queue errors

Primary files:
- `pos/src/main/frappe.ts` — pushEvents transport only
- `pos/src/main/sync.ts`
- `pos/src/main/sync.test.ts`
- `raspechatka/api/pos_v2.py` — push_events dispatcher/transaction boundary only
- focused server tests around push_events
- `docs/access-control-contract.md` read-only

Protocol:
- extend the existing response additively from `{accepted:string[]}` to conceptually:
  `{accepted:string[], errors:[{id,eventType,message}]}`.
- Older callers that read only `accepted` remain compatible.

Requirements:
1. Process each event inside a server DB savepoint using the current Frappe DB savepoint/rollback API. Verify the exact framework API before coding.
2. If one event fails, rollback only that event’s DB changes, append a concise error entry and continue with the remaining independent events.
3. Do not expose traceback/secrets in the returned message.
4. Unsupported event types are not accepted; report them as errors instead of silently making them invisible.
5. The client marks only `accepted` IDs sent. Failed IDs remain pending.
6. If a batch returns errors, persist a truthful `outbox_error` summary including event type/id enough for diagnostics. `documentQueueSynced` remains false.
7. Avoid a hot retry loop in the same sync cycle: after processing the batch and marking successes, do not immediately spin forever on the same failed IDs.
8. If any events were accepted, keep existing read-after-write bootstrap even when other events failed.
9. A failed event must not block valid later events in the same batch.
10. Focused tests:
   - first event rejects, second valid event is accepted;
   - rejected ID remains pending, accepted ID becomes sent;
   - accepted canonical DB changes survive while failed event’s partial DB changes are rolled back;
   - result reports event-level error;
   - unsupported event stays pending;
   - read-after-write still runs after partial acceptance.
11. Do not alter cashier ownership or idempotency checks.

## Stage DEV-168 (2) — real order round trip: POS outbox → POS Order → Sales → Orders

Primary files:
- `pos/src/main/database.ts` order queue methods only if a proven defect remains
- `pos/src/main/ipc.ts` order handlers only if a proven defect remains
- `pos/src/main/sync.ts` only if stage (1) evidence requires it
- `raspechatka/api/pos_v2.py` order dispatch/trusted cashier only
- `raspechatka/api/pos.py` / `pos_device.py` order ingestion only
- `raspechatka/api/sales.py` `get_orders` only
- `raspechatka/tests/test_pos_orders.py`
- `raspechatka/tests/test_pos_order_visibility.py`
- a new true Frappe integration test allowed
- existing relevant DocTypes/fixtures may be read narrowly

Requirements:
1. Add a regression that uses real Frappe documents/DB validation rather than an in-memory mocked store wherever the test harness permits:
   POS Connection/current point + Employee + real POS Order DocType, then call the real `pos_v2.push_events` path for `order.created` and `order.updated ready`.
2. Assert canonical POS Order exists at the authenticated point with items/status/timestamps.
3. Call the real scoped `sales.get_orders` and prove the row is returned for the allowed point and hidden for a foreign point.
4. Prove the same order survives bootstrap/read-after-write and does not duplicate on replay.
5. If `order.updated` arrives without its canonical order, it must NOT be silently accepted and lost. Return/reject it so it stays pending until the create event succeeds.
6. Reproduce the real-workstation failure with the smallest concrete fix. Do not redesign the already-existing SalesPage orders UI.
7. Preserve point scope, trusted cashier and source receipt linkage.
8. Focused client/server tests only during this stage.

## Stage DEV-168 (3) — real warehouse round trip: receipt + write-off

Primary files:
- `pos/src/main/database.ts`:
  `createStockReceipt`, `reportStockWriteOff` and related outbox behavior only
- `pos/src/main/ipc.ts` related handlers only if necessary
- `raspechatka/api/pos_v2.py`: `_ingest_stock_receipt`, `_ingest_stock_write_off` only
- `raspechatka/raspechatka_os/doctype/stock_receipt/**` READ first; minimal fix only if real validation exposes defect
- `raspechatka/raspechatka_os/doctype/stock_write_off/**` same
- `raspechatka/raspechatka_os/doctype/purchase_order/purchase_order.py` receive-status logic
- `raspechatka/tests/test_pos_warehouse_contract.py`
- new real Frappe integration tests allowed

Receipt acceptance scenario:
1. Create a real submitted Purchase Order at Point A with real item/warehouse/supplier and remaining quantity.
2. Send real `stock.receipt.requested` through `pos_v2.push_events`.
3. Assert a submitted `Stock Receipt` exists with:
   - source POS;
   - external_id = event id;
   - cashier employee;
   - purchase order and server-owned supplier/warehouse/rate;
   - correct item/quantity.
4. Assert Purchase Order received quantities/status update to partial/full as appropriate.
5. Replay same event: no duplicate receipt/stock ledger.
6. Foreign-point Purchase Order remains rejected.

Write-off acceptance scenario:
7. Seed a realistic stock balance/ledger state at Point A.
8. Send `stock.write_off.requested` through real push_events.
9. Assert a submitted canonical `Stock Write Off` appears under Warehouse → Write-offs with source POS/cashier/event id and stock effect.
10. Replay is idempotent; foreign point/item context cannot be forged.

POS local truth:
11. Remove the misleading irreversible optimistic mutation in `createStockReceipt` that hides/changes a delivery before the server accepts it. Queue the request durably; canonical bootstrap after acceptance becomes the authority that removes/updates the delivery. Do not modify WorkPage in this DEV.
12. Failed receipt/write-off remains pending with the event-level error from stage (1).
13. No blind retry/new stock document is generated for an already accepted event.

## Stage DEV-168 (4) — Web OS “Внутренние заказы” backend/access over Point Supply Request

Primary files:
- new `raspechatka/api/internal_orders.py` (preferred bounded owner API) or an equally narrow warehouse-owned module
- `frontend/src/access-pages.json`
- `docs/access-control-contract.md` read-only
- `raspechatka/scope.py` read-only shared scope helpers
- `raspechatka/raspechatka_os/doctype/point_supply_request/**` read-only unless a proven field defect exists
- focused backend/access tests

Do not create a new DocType or migration. Reuse `Point Supply Request`.

Access:
1. Add unique page area `page.warehouse.internal_orders`, label “Внутренние заказы”, route `/warehouse/internal-orders`, under Warehouse.
2. Do not use a legacy-area permission shortcut for this new page; ordinary roles start deny-by-default. System Manager/network admin behavior remains per access framework.
3. New session endpoints declare `@access_contract(area="page.warehouse.internal_orders", action="read", scope="point")`.
4. Use shared `point_filter` / scope helpers; client point filter is not authority.

Read API:
5. Add paginated read-only list endpoint with filters sufficient for first version:
   - search (document id/item name/comment);
   - status;
   - business_point;
   - optional date range if it fits the standard helper cleanly.
6. Return at minimum:
   - document name/id;
   - creation/request date;
   - business point ID + display name;
   - requested_by_employee ID + display short/full name field;
   - item/item_name;
   - quantity;
   - comment;
   - status.
7. Hydrate point/employee display names in batch; no N+1.
8. Add options endpoint or equivalent safe payload for only allowed points/statuses.
9. Negative tests: foreign point filter/document not visible; user without page View rejected.
10. Keep the page read-only in this DEV; no procurement/selection/fulfilment workflow yet.

## Stage DEV-168 (5) — Web OS “Внутренние заказы” frontend

Primary files:
- new `frontend/src/pages/InternalOrdersPage.vue`
- `frontend/src/router.js`
- `frontend/src/access-pages.json` only if stage (4) did not already add final registry entry
- existing shared components:
  `ListPageHeader.vue`, `SmartFilterBar.vue`, `SmartDataTable.vue`
- `docs/list-workspace.md` read-only
- focused frontend tests if an existing list-registry pattern supports them

Requirements:
1. Route `/warehouse/internal-orders`, module Warehouse.
2. Page title exactly “Внутренние заказы”.
3. Read-only first version; no create/edit/status buttons.
4. Use standard ListPageHeader + SmartFilterBar + SmartDataTable, unique `viewKey="warehouse.internal-orders"`.
5. Default visible business columns:
   - Дата;
   - Точка;
   - Сотрудник;
   - Товар / что требуется;
   - Количество;
   - Комментарий;
   - Статус.
6. Search/status/point filters use the backend API; keep server-side scope.
7. Empty/loading/error states follow current list workspace conventions.
8. The POS button remains named “Потребность точки”; its existing event creates Point Supply Request, which then appears on this page after sync.
9. No purchasing/batch-fulfilment logic yet.

## Whole-DEV acceptance

- One poisoned POS outbox event no longer blocks unrelated valid documents and the exact rejected event is visible in queue error state.
- POS orders created/updated on a real Frappe test path appear in existing Sales → Orders under correct point scope.
- POS receiving creates a submitted Stock Receipt and closes/partially closes the Purchase Order canonically; a failed receive is not hidden locally as if successful.
- POS write-off creates a submitted Stock Write Off and changes stock once, idempotently.
- POS “Потребность точки” creates the existing Point Supply Request and Web OS exposes it under Warehouse → Internal Orders with point/date/employee/item/qty/comment/status.
- No new duplicate supply-request DocType, no payment/fiscal behavior change.
- Final only: focused server + POS tests, full repository Quality Gate/Server CI/POS checks as applicable, one PR into version-16 after all five parts are reviewed.
