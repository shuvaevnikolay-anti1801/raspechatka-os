# DEV-167 — Windows POS workplace UX polish after real-workstation acceptance

Branch: `codex/dev-167-pos-workplace-ux`  
Base: `version-16@3566a5f119676ab6539d29336d847ae631710c2e`

## Scope

Polish only Windows POS → Work:
- “График работы”;
- “Товары и склад” visual composition and its local renderer forms.

DEV-165 established the data flow and basic stacking. Manual acceptance shows that the information is still too small/stretched and hard to scan on a real laptop. This DEV changes presentation only.

Do not change POS→OS warehouse/outbox behavior here; DEV-168 owns order/receipt/write-off/supply synchronization.
Do not change sale/payment/auth screens; DEV-166 owns them.

## Invariants

- Preserve `WorkplaceData`, bootstrap/offline cache and all IPC/shared contracts.
- Shift codes stay U/V in data. Display mapping remains У / В / У/В.
- Work schedule remains read-only.
- Preserve existing colors already matched to Web OS:
  - morning #fff4a8;
  - evening #a9cef7;
  - both = 50/50 diagonal.
- Warehouse actions still call the existing `reportStockWriteOff`, `createSupplyRequest`, `createStockReceipt` contracts exactly as before.
- No server/API/DocType/sync changes.
- Angular structural style, no decorative rounded cards.
- Use existing `formatPersonShortName` helper; do not create another person-name formatter.

## Current verified facts

- `WorkPage.tsx` is already extracted from `AppV2.tsx`.
- Monthly graph currently renders `employee.name` in full.
- `person-name.ts` already supplies the POS short-name convention used elsewhere.
- `workplace.css` uses very small schedule/upcoming typography (roughly 9–13px in key places).
- The monthly graph is first/full-width and upcoming shifts are below, but “Мои ближайшие 5 смен” still reads as a thin stretched row rather than a cashier-friendly summary.
- Warehouse top currently renders a heading/copy (“Товары и склад”, “Остатки и поставки текущей точки”) plus subtle action buttons.
- User wants the two actions to become the visual start of the page:
  - “Списать брак” = restrained warning/danger accent;
  - “Потребность точки” = green accent.
- Delivery cards and receiving/write-off/supply forms are visually stretched/tiny.
- Some Work cards currently use rounded corners; this conflicts with the approved angular POS style.

## Stage DEV-167 (1) — schedule readability and short employee names

Primary files:
- `pos/src/renderer/src/WorkPage.tsx` — schedule branch only
- `pos/src/renderer/src/workplace.css` — schedule/upcoming rules only
- `pos/src/renderer/src/person-name.ts` READ ONLY unless a proven bug exists
- focused workplace renderer tests
- `frontend/src/pages/TeamPage.vue` READ ONLY only if shift color/label semantics need reconfirmation

Requirements:
1. In the monthly employee column display `formatPersonShortName(employee.name)`, e.g. “Шуваев Н. А.”. Full employee identity remains in data.
2. Apply the same short display convention to any employee name repeated inside Work schedule presentation where the full name wastes space; do not change data contracts.
3. Keep monthly graph first and full-width.
4. Improve graph scanability: employee column has a sensible bounded width, days/cells align, labels are readable, no giant empty gutters and no tiny text.
5. Redesign “Мои ближайшие 5 смен” as clear shift cards/rows rather than one stretched microscopic line. Each item should prioritize:
   - date;
   - Утро/Вечер or У/В semantic label;
   - time range;
   - planned hours as secondary information.
6. Use the same morning/evening/both color semantics without inventing a second palette.
7. Responsive behavior must remain usable on common POS laptop width without horizontal squeeze of the upcoming-shift block.
8. Focused tests: short-name helper used; U/V/both labels preserved; exact color classes/semantics preserved; graph before upcoming; schedule stays read-only.

## Stage DEV-167 (2) — warehouse workspace hierarchy and delivery cards

Primary files:
- `pos/src/renderer/src/WorkPage.tsx` — warehouse branch, toolbar, DeliveryCard only
- `pos/src/renderer/src/workplace.css` — warehouse/delivery layout only
- focused renderer tests

Requirements:
1. Remove the redundant visual header/copy “Товары и склад / Остатки и поставки текущей точки” from the warehouse workspace.
2. Start the page with a left-aligned primary action row:
   - “Списать брак” prominent with a restrained warning/red accent;
   - “Потребность точки” prominent with Raspechatka green accent.
   The buttons must be immediately discoverable and touch-sized.
3. Below actions, keep the business order:
   - supplier deliveries;
   - stock/search/storage.
4. Recompose delivery cards so the important information forms a compact hierarchy rather than stretching across the full width:
   - supplier/order;
   - expected date/status;
   - delivery/company/code/note if present;
   - remaining lines/quantities;
   - one obvious receiving action.
5. Do not invent new delivery statuses or sync state in this DEV.
6. Remove decorative rounded card styling in this scoped Work UI; structural cards/actions are angular.
7. Stock list/search remains functionally identical but gets readable spacing/column widths on laptop size.
8. Focused tests: action row first; old redundant title/copy absent; both existing callbacks still wired; delivery data/receive action preserved; stock/search preserved.

## Stage DEV-167 (3) — warehouse operational forms

Primary files:
- `pos/src/renderer/src/WorkPage.tsx` — `ReceiveModal`, `WriteOffModal`, `SupplyRequestModal` only
- `pos/src/renderer/src/workplace.css`
- generic modal styles only if a narrowly scoped Work class is added
- focused renderer tests

Requirements:
1. Do not reuse tiny generic form composition blindly. Give the three warehouse actions a dedicated readable Work-modal layout while retaining the existing modal foundation.
2. Receiving:
   - order/supplier context visible at top;
   - each remaining item readable;
   - quantity input visually attached to the item/uom/remaining quantity;
   - final confirm action obvious;
   - no business validation change.
3. Write-off:
   - item selector/search, quantity, reason and comment readable/touch-sized;
   - warning accent indicates an irreversible stock fact without looking like a generic error.
4. Supply request:
   - item/description, quantity and comment arranged clearly;
   - action remains named “Потребность точки”.
5. Inputs/buttons target ~48px minimum interactive height where practical.
6. Keep exact payloads and API calls; no backend/sync changes.
7. Structural surfaces angular.
8. Focused tests: payload callbacks are unchanged; modal close/submit works; no additional required business fields; receiving quantities still constrained by existing data.

## Whole-DEV acceptance

- Monthly graph shows short employee names and is easier to scan.
- Upcoming five shifts are readable at a glance.
- Warehouse page begins with two obvious actions, not redundant headings.
- Deliveries, stock and receiving forms use the laptop area intelligently instead of stretching tiny content.
- Existing warehouse/schedule behavior and contracts are unchanged.
- Final only: POS typecheck/test/build once; one PR into version-16 after all three parts are reviewed.
