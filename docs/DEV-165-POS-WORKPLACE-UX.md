# DEV-165 — Windows POS: Work page visual cleanup

Branch: `codex/dev-165-pos-workplace-ux`  
Base: `version-16@4030e47f120efe87d872642c2d2f69dbd64d2e1e`  
Plans: PLAN-058, PLAN-059.

## Goal

Improve only Windows POS Work → “График работы” and “Товары и склад” layout using the already implemented workplace contracts. No server/schema/business changes.

## Current facts from stable

- `WorkPage` is currently embedded in the large `AppV2.tsx`.
- Schedule layout CSS is two columns: `.work-schedule { grid-template-columns:minmax(250px,320px) minmax(0,1fr) }`, putting “Мои ближайшие 5 смен” beside “График точки”.
- POS schedule cells render raw `shiftCode || shiftName` and all shifts use the same green `.schedule-mark`.
- Web OS `TeamPage.vue` is the current visual/semantic reference:
  - U -> “У”;
  - V -> “В”;
  - both -> “У/В”;
  - morning background `#fff4a8`;
  - evening background `#a9cef7`;
  - both = diagonal 50/50 gradient of those two colors.
- Warehouse render order is already actions → deliveries → stock, but it sits inside generic `.work-grid`, currently a three-column grid, so the blocks render as columns rather than stacked full-width rows.

## Invariants

- Preserve `WorkplaceData`, offline cached data and all existing server contracts.
- Shift codes stored/transmitted remain U/V; translate only display labels.
- Work schedule remains read-only in POS.
- Do not change warehouse write-off, supply request or stock receipt business behavior.
- Do not touch sale/payment/fiscal/TransactionEngine.

## Architecture

Extract `WorkPage` and its closely related renderer-only workplace helpers/components into a focused module so later Work UX changes do not keep growing `AppV2`. Keep existing exports compatible where practical or update only directly related tests.

Use one focused Work stylesheet rather than adding more generic `.work-grid` overrides that affect unrelated screens.

## Stages

### DEV-165 (1) — WorkPage extraction + schedule UX

Primary files:
- `pos/src/renderer/src/AppV2.tsx` — extract WorkPage invocation/exports only;
- new `WorkPage.tsx` / `workplace.css` allowed;
- `frontend/src/pages/TeamPage.vue` read-only reference for shift labels/colors;
- `pos/src/shared/contracts.ts` read-only;
- `AppV2.contract.test.tsx` / focused workplace renderer tests.

Deliver:
- move WorkPage and its local helpers cleanly out of AppV2 without behavior change;
- schedule screen order: full “График точки” first and full available width, then “Мои ближайшие 5 смен” below;
- display U as “У”, V as “В”; multiple morning+evening entries for same cell as “У/В”;
- exact Web OS color semantics: morning #fff4a8, evening #a9cef7, both 50/50 diagonal;
- keep current month/current point read-only data and hours;
- make grid visually cleaner/readable, no edit controls.

### DEV-165 (2) — stacked warehouse workspace

Primary files:
- extracted `WorkPage.tsx` and workplace stylesheet;
- existing `DeliveryCard`, Receive/WriteOff/Supply modal code within that focused module;
- current contracts read-only;
- focused renderer tests.

Deliver:
- “Товары и склад” becomes one vertical workspace:
  1. compact actions header/buttons;
  2. supplier orders/deliveries full width;
  3. products/stock/search/storage full width.
- remove the three-column visual squeeze;
- preserve existing expansion, receive, write-off, needs, search and stock data;
- no extra horizontal scrolling caused by the page layout on supported POS widths;
- keep business logic unchanged.

## Acceptance

- POS graph uses Russian У/В/У/В labels while stored codes stay compatible.
- Shift colors match Web OS semantics.
- Full monthly graph is first/full-width; upcoming five shifts are below.
- Warehouse blocks are rows, not columns.
- Existing workplace actions behave exactly as before.
- No backend/schema/sync changes.
