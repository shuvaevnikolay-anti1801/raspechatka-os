# DEV-174 — POS Warehouse Operations

Base: `version-16` @ `91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Plan: PLAN-064.

## Current state

Warehouse UI is in `pos/src/renderer/src/WorkPage.tsx`. Write-off currently has separate product search/select affordances, allows reason `Другое` and optional comment. Point-supply request carries quantity and optional comment. Delivery/stock views expose technical identifiers not needed by a cashier. Server ingestion and idempotency live in the existing POS v2 outbox handlers and owner-domain stock/supply code.

## Architecture decisions

1. Write-off keeps the existing stock mutation/event type and idempotency key. UX becomes one searchable product selector; product and quantity are required. Allowed reasons are exactly the three existing business reasons other than `Другое`; comment becomes required. Active cashier identity is captured through the existing employee/auth context and persisted as author metadata through the outbox/server path. Do not trust renderer-supplied arbitrary employee identity when server can validate context.
2. `Потребность точки` is renamed `Заказать`. New request semantics contain selected product/name and required comment; requested quantity is removed from the new POS flow. Make server/contract evolution backward-compatible with already queued old payloads containing quantity: accept them safely, but do not require or display quantity for new requests.
3. Delivery cards are horizontal and operational: supplier, comment, product lines/quantities and action. Hide internal order IDs, barcode/SKU and other technical fields from cashier UI, but do not delete them from storage/API if required for reconciliation.
4. Stock list hides technical IDs while preserving product name and operational stock data.

## Stages

1. Contracts/server: `pos/src/shared/contracts.ts`, relevant warehouse event builders in `pos/src/main/frappe.ts`/main IPC, `raspechatka/api/pos_v2.py` and existing stock/supply owner-domain handlers/tests. Add required validation/author metadata and backward-compatible no-quantity supply semantics.
2. Renderer: warehouse sections/modals in `pos/src/renderer/src/WorkPage.tsx`, related CSS/tests. One searchable selector, exact reasons, required comments, simplified stock/delivery cards.

## Safety invariants

Do not change stock arithmetic, warehouse ownership, idempotency or server authorization. A duplicate outbox delivery must not duplicate stock/write-off/supply side effects. Old queued payloads remain processable. UI hiding of technical identifiers must not remove reconciliation data from contracts/storage.

## Acceptance

Write-off cannot submit without product, positive quantity, allowed reason and comment; author is the actual active cashier. `Заказать` has no quantity control and requires product + comment. Delivery cards and stock list contain no cashier-facing internal IDs/SKU/barcodes. Existing receipt/write-off idempotency from DEV-168 remains intact.

One final PR/CI only after both stages and architect review.