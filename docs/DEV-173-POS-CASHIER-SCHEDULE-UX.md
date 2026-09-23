# DEV-173 — POS Cashier Access + Schedule UX

Base: `version-16` @ `91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Plans: PLAN-059, PLAN-063.

## Current state

Cashier access/PIN already uses shared renderer primitives but selection and four-digit PIN visuals are not fully unified. Workplace schedule receives `scheduleMonth` plus upcoming shifts from the existing workplace endpoint, so the renderer cannot reliably render a second calendar month without another server contract.

## Architecture decisions

1. This DEV changes only presentation of the existing cashier selection/authentication flow: idle cashier cards get a thin green outline, selected card uses green fill, and all 4-digit PIN entry surfaces use one shared four-slot visual from the existing `PinEntry.tsx`/`PinInput` primitive. Keyboard entry, focus, validation, lockout/auth semantics and permissions remain unchanged. Increase the interaction/focus footprint around `Настройки кассы` and `Забыли PIN` without changing their behavior.
2. Extend the existing workplace payload additively with the next calendar month schedule using the same day/shift contract as the current month. Month generation must be calendar-based, including December → January and year change, and remain scoped to the authenticated employee/point exactly as today.
3. Work page order: `Мои ближайшие 5 смен` first, then current month calendar, then next month calendar. Upcoming cards use full weekday + date (`23 сентября`) and a compact badge only from `Утро`, `Вечер`, `Утро / вечер`; do not show time or duration in that badge. Month headings include month and year. Avoid clipping at normal POS desktop sizes.

## Stages

1. Cashier/PIN renderer: existing shared PIN component, cashier selection components in AppV2/auth renderer, relevant CSS/tests only.
2. Schedule contract/backend: `pos/src/shared/contracts.ts`, `pos/src/main/frappe.ts`, `raspechatka/api/pos.py` (`_get_workplace_data`, `_get_schedule_month`) and `raspechatka/api/pos_v2.py` wrapper if required; focused Python/TS contract tests.
3. Schedule renderer: `pos/src/renderer/src/WorkPage.tsx`, related CSS/tests only.

## Acceptance

All 4-digit PIN contexts have the same four green-bordered slots and entered dots while retaining existing keyboard/auth behavior. Upcoming 5 shifts are fully visible and precede calendars. Two consecutive calendar months render with correct year rollover and no duplicated/missing month. No changes to roles, authorization, Employee model or sale logic.

Intermediate stages do not create PR/merge/deploy or run full Windows packaging.