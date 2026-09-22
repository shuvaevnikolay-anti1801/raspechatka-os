# DEV-164 — Windows POS orders: reliable sync to Raspechatka OS

Branch: `codex/dev-164-pos-order-sync`  
Base: `version-16@4030e47f120efe87d872642c2d2f69dbd64d2e1e`  
Plan: PLAN-057.

## Goal

Make POS order creation/status updates reliably reach canonical `POS Order` in Raspechatka OS, become visible through the existing Web OS Sales → Orders page, and make manual synchronization report the real document-queue result.

This is not a new Orders module. Reuse the existing DEV-156 model, DocTypes, outbox, POS v2 endpoint and Web OS page.

## Current facts from stable

### POS

- `PosDatabase.createPaidOrderFromSaleSnapshot`, `createUnpaidOrder` and `updateOrder` queue `order.created` / `order.updated`.
- `updateOrder` owns the valid status transitions and first `readyAt` / `issuedAt` timestamps.
- Order IPC handlers call `assertCashierAccess()` but discard the returned employee ID before calling database order methods.
- Generic `database.queue(...)` only attaches a trusted `cashierId` when explicitly supplied or inferable from an open shift.
- Therefore an authenticated cashier can update an order while no shift is open and leave an order event without a durable cashier ID.

### Server

- `raspechatka.api.pos_v2.push_events` calls `_trusted_event_cashier`.
- Without payload/fallback cashier and without a linked Sales Shift, an order event is rejected as “Кассир события не назначен на текущую точку”.
- Order ingestion is already point-scoped and delegates to existing `POS Order` helpers.
- Create is idempotent by `source_pos_event=event_id`; update resolves order_number + business_point and preserves first ready/issued time.

### Sync

- `runSync` currently loads bootstrap (including server orders) **before** pushing outbox events.
- After accepted events it does not load bootstrap again. A newly accepted order can therefore remain absent from the local server snapshot until the next sync cycle.
- A bootstrap success can make the overall call return even when outbox failed; the error is stored in `sync_error`.
- Renderer manual sync currently shows “Данные обновлены” on any resolved `syncNow()`, which can misrepresent a document queue failure.

### Web OS

The Web OS Orders page already exists:
- route `/sales/orders`;
- `page.sales.orders`;
- `SalesPage.vue` orders table/filters;
- `raspechatka.api.sales.get_orders/get_order_options` with point-scoped access contract.

Do not build a second orders page.

## Invariants

- Do not change payment/fiscal transaction ordering.
- An order attached to a sale is still created only after the safe completed sale path.
- Do not invent blind retries for money/fiscal operations.
- Order outbox retries must remain idempotent.
- Server never trusts client point identity; POS token connection determines point.
- Existing order status transitions remain `new|in_progress -> ready -> issued`.
- Preserve offline-first: local order actions remain usable and queue durably.

## Stages

### DEV-164 (1) — trusted cashier evidence for order events

Primary files:
- `pos/src/main/database.ts` order methods + queue call only;
- `pos/src/main/ipc.ts` order handlers only;
- `pos/src/shared/contracts.ts` only if signatures need additive typing;
- `raspechatka/api/pos_v2.py` / `pos_device.py` / `pos.py` read current ingestion; change only for a proven defect;
- `pos/src/main/database.test.ts`, sync/order focused tests;
- `raspechatka/tests/test_pos_orders.py`.

Deliver:
- capture the authenticated cashier ID at IPC boundary and persist it in queued order events even when no work shift is open;
- delayed sync after logout/restart can still prove who made the order action;
- duplicate event IDs remain harmless;
- foreign-point/cashier evidence remains rejected.

Do not modify TransactionEngine.

### DEV-164 (2) — read-after-write sync and truthful manual status

Primary files:
- `pos/src/main/sync.ts`;
- `pos/src/main/frappe.ts`;
- `pos/src/main/database.ts` only sync/order snapshot helpers;
- `AppV2.tsx` manual sync helper only if needed for truthful message;
- `ConnectionStatus` typing only if an existing field is insufficient;
- `pos/src/main/sync.test.ts`.

Deliver:
- after successfully accepting order/document outbox events, refresh the canonical bootstrap/order snapshot in the same synchronization cycle, or implement an equivalent deterministic read-after-write path;
- do not leave a just-sent order “one sync behind”;
- manual UI must not say “Данные обновлены” while document outbox failed or relevant pending events remain;
- distinguish “server reachable/master data refreshed” from “document queue fully sent”;
- preserve independent bootstrap/outbox failure handling and offline behavior.

### DEV-164 (3) — end-to-end order visibility proof

Primary/read files:
- `pos/DEV-156-ORDERS.md`;
- `raspechatka/api/pos.py`, `pos_v2.py`, `pos_device.py` order path only;
- `raspechatka/api/sales.py` get_orders/options only;
- `frontend/src/pages/SalesPage.vue` orders mode only;
- `frontend/src/router.js`, `access-pages.json` read to confirm existing route/access;
- `docs/access-control-contract.md`;
- focused server tests.

Deliver:
- regression test proving POS `order.created` and subsequent ready update become canonical `POS Order` and are returned by the existing point-scoped Web OS Orders query;
- negative test for a foreign point/scope;
- bootstrap round-trip remains compatible;
- only fix frontend/backend code if this end-to-end proof exposes a concrete defect. Do not rewrite the already-existing page.

## Acceptance

- An authenticated cashier can create/update an order with no open shift and the queued event still carries trusted cashier identity.
- “Готов к выдаче” reaches the canonical OS order.
- Duplicate/replayed order events do not create duplicate orders or rewrite first ready/issued timestamps incorrectly.
- One manual sync is enough for the accepted server state to become visible locally/server-side.
- Manual sync does not report false success for an unsent order queue.
- Existing Web OS Sales → Orders shows the order under correct scope.
- No new Orders entity/page and no money/fiscal behavior changes.
