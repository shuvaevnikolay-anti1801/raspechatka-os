# DEV-171 — POS Orders: customer/contact flow

Base: `version-16` @ `91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Plans: PLAN-058, PLAN-060.

## Current state

Sale order creation currently carries `{phone, comment?, dueAt?}`. `OrdersPage.tsx` exposes duplicate/technical order identifiers, uses fiscal-receipt information in the payment area, has a separate `Найти чек` control plus sale select, does not load a full selected-sale item preview, and marks issue immediately. Order edit has phone/comment/dueAt only.

## Architecture decisions

1. Add first-class optional `contactMethod` to the POS order contract and server round-trip. Do not overload `comment` with contact method. Keep old records/payloads valid when field is absent.
2. User-facing labels are `Телефон`, `Способ связи`, `Дата выдачи`, `Описание`. Sale `Оформить заказ` uses this order: phone → contact method → date → description.
3. Order creation uses one mandatory sale/check selector; remove the independent `Найти чек` affordance. After selection, load the already available sale-detail endpoint (`getSale(selected.id)`) and show date/time without seconds, amount, customer or `Розничный покупатель`, and complete line list with quantities. Treat a stale/missing detail as a recoverable validation error; never create against an unresolved sale.
4. Orders table starts with Status and exposes one user-facing order number only, then phone, contact method, description, paid + amount, created, issue date, actions. Do not expose internal IDs/fiscal IDs. Use the existing POS table/resizable-column pattern if already available in the renderer; do not introduce a new table framework.
5. Issue is a confirmed state transition. Before existing issue mutation show modal text exactly `Подтверждаете ли выдачу заказа?`, primary `Подтверждаю`, secondary `Отмена`. Guard against double submit while mutation is in flight and retain server idempotency.

## Stages

1. Contract/data round-trip: `pos/src/shared/contracts.ts`, `pos/src/main/frappe.ts`, order IPC/main plumbing in `pos/src/main/index.ts`, `raspechatka/api/pos_v2.py` and the existing order owner-domain handler used by it. Additive/backward-compatible only.
2. Sale order modal: order draft/submission section of `pos/src/renderer/src/AppV2.tsx`, relevant CSS/tests. No table work.
3. Orders workplace: `pos/src/renderer/src/OrdersPage.tsx`, relevant CSS/tests. Use existing sale-detail API; no new redundant sale endpoint.

## Acceptance

Create and edit preserve phone/contact method/date/description; old orders with no contact method render safely. Selected-sale preview shows all lines/quantities and cannot silently use stale detail. Table has one order number and no technical/fiscal identifiers. Issue requires the exact confirmation dialog and cannot double-submit. Existing payment/fiscal/sale data is read-only in this DEV.

## Non-goals

No change to sale calculations, payment or fiscal semantics, stock movements, TransactionEngine or authorization model. One final PR/CI after all stages and architect review.