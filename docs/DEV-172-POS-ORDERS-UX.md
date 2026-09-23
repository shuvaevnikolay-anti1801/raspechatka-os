# DEV-172 — POS orders: one contract, form and issue flow

Plans: PLAN-058, PLAN-060.
Baseline: `version-16@91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Branch: `codex/dev-172-pos-orders-ux`.

## User outcome
Creating an order from Sale or from Orders uses the same fields and validation. Standalone creation is anchored to a paid receipt with a useful preview; list/edit/issue flows show business information instead of technical IDs.

## Current facts
- POS `Order`, Create/Update request types and local SQLite order table have no contact method.
- Canonical `POS Order` DocType has phone/comment/due_at but no contact method.
- `OrdersPage.tsx` uses a separate receipt-search field, exposes technical identifiers/seconds and marks `Выдан` immediately.
- Sale order draft has phone/comment/dueAt only.
- DEV-164/168 already established trusted cashier evidence, idempotent order outbox, point scope and read-after-write sync; these invariants must remain.

## Fixed contracts
1. Add optional/free-text `contactMethod` end-to-end: renderer form → shared types → SQLite → order.created/order.updated payload → POS v2 ingest → canonical POS Order → bootstrap/read models. Additive schema only; old rows/events remain valid.
2. Shared order-form fields/order: phone → contact method → `Дата выдачи` → description. Sale create, Orders create and edit reuse the same field/validation contract.
3. Standalone Orders creation requires selecting an existing paid sale/receipt. The selected receipt preview shows date/time to minutes, amount, buyer (`Розничный покупатель` fallback), all item names and quantities. Do not add a second free-text `Найти чек` control if the selector itself can search/filter.
4. Orders table starts with status; show user order number, not internal DB ID. Show phone/contact/description, payment as `Оплачено · <amount>`, created/due/issued without seconds. Columns are resizable locally; persistence may reuse existing workstation UI preferences but must not become server business data.
5. `Выдан` always opens confirmation `Подтвердить выдачу заказа?` with `Подтверждаю` / `Отмена`; while update is pending, duplicate submit is blocked. Existing first-issued timestamp/idempotency rules remain.
6. Do not change payment/fiscal semantics, source-sale ownership, point scope or trusted cashier checks.

## Stages
1. Additive contact-method storage/server roundtrip + migrations/tests.
2. Extract/reuse unified order form across Sale/create/edit.
3. Paid receipt selector + complete preview.
4. Orders table business columns + resizable columns/date formatting.
5. Issue confirmation/double-submit guard + end-to-end regression.

## Acceptance
Real server regression proves create/update/contactMethod/replay/foreign-point denial and bootstrap roundtrip. Renderer tests prove identical forms, required paid receipt for standalone create, preview contents, no technical ID/seconds, resize behavior, confirmation and duplicate blocking. Full CI only at final architect gate.