# DEV-174 — POS Work: schedule and warehouse actions

Plans: PLAN-063, PLAN-064.
Baseline: `version-16@91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Branch: `codex/dev-174-pos-work-pages`.

## User outcome
Work opens with the cashier's next shifts, then current and next month point schedules. Warehouse forms are simpler, attribute durable stock/request events to the active employee, and hide technical IDs without changing stock semantics.

## Current facts
- Bootstrap provides one `scheduleMonth` plus five upcoming shifts; WorkPage renders the month before upcoming and shows time/hours.
- Warehouse write-off has a normal select, includes `Другое`, and comment is optional.
- Supply request currently carries quantity and optional comment.
- POS v2 already has trusted cashier plumbing and canonical Stock Write Off / Point Supply Request ingestion; stock receipt idempotency from DEV-168 must remain.

## Schedule contract
1. Bootstrap/workplace data provides current and next calendar month explicitly, including Dec→Jan. Old cached bootstrap with only `scheduleMonth` still renders safely.
2. UI order: `Мои ближайшие 5 смен` first; cards show full weekday, date like `23 сентября`, and semantic `Утро`, `Вечер`, or `Утро / вечер`. Do not show start/end time, planned hours or duration in those cards.
3. Then two read-only point schedules, each labelled month + year. Existing U/V internal codes and approved colors remain.

## Warehouse contract
1. Write-off item is a searchable selector over operational catalog but submits the same canonical product ID. Allowed reasons are exactly `Брак`, `Внутренние нужды`, `Обучение`; comment is required both renderer and server-side.
2. Trusted active employee comes from main-process cashier auth/outbox and is persisted as canonical employee on Stock Write Off; renderer cannot supply a different cashier.
3. Rename POS action `Потребность точки` to `Заказать`. Remove quantity from POS request contract/UI; comment is mandatory. Canonical Point Supply Request remains the existing DocType. For compatibility its required quantity storage, if still structurally required, must use one explicit server-owned compatibility value rather than a user-editable quantity; do not create another DocType.
4. Delivery and stock UI hide technical item/order IDs and barcode/code where requested, but IDs stay in data/contracts for actions. Receiving logic, quantities and server-side supplier/warehouse/rate authority are frozen.

## Stages
1. Current+next schedule backend/shared contract with cached compatibility.
2. Schedule renderer order/cards/two-month UX.
3. Warehouse event/server contract: trusted employee, reasons/comment, quantity-less supply request + real Frappe regressions.
4. Warehouse searchable form and compact delivery/stock UI.

## Acceptance
Tests cover Dec→Jan, old bootstrap, U/V/both colors, read-only schedule, searchable write-off selection, server rejection of invalid reason/empty comment/foreign cashier context, quantity-less supply request compatibility, idempotent stock effect and unchanged receipt flow. Full CI only at final architect gate.