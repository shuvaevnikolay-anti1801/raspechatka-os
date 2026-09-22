# DEV-162 — Windows POS: sale workspace redesign

## Status and scope

Branch: `codex/dev-162-pos-sale-redesign`  
Base: `version-16@4030e47f120efe87d872642c2d2f69dbd64d2e1e`  
Plans: PLAN-056, PLAN-060 + approved sale/payment/success UX decisions from 2026-09-22.

This DEV redesigns **only the Windows POS sale flow**: sale workspace, payment modal, and successful-sale overlay. Preserve all current business logic, transaction safety, offline behavior, pricing, discounts, upsell rules, customer behavior, order creation, held receipts, payment/fiscal execution and printer contracts.

Do not redesign Receipts / Orders / Shift / Work / Settings in this DEV.

## Current source of truth

Renderer entry point is `pos/src/renderer/src/main.tsx`, which mounts `AppV2`, `PaymentModalV2`, `SaleSuccessOverlay` and the global helpers.

Current sale state/business orchestration lives in `pos/src/renderer/src/AppV2.tsx`.
Current payment UI lives in `pos/src/renderer/src/PaymentModalV2.tsx`.
Current success UI lives in `pos/src/renderer/src/SaleSuccessOverlay.tsx`.
Current styles are split across `styles.css`, `pos-v2.css`, `checkout.css`, `pilot-ux.css`.
Theme tokens come from `shared/raspechatka-theme.css`:
- green: `--rp-green: #a1ce0f`;
- white/paper;
- graphite: `--rp-ink: #272727`;
- muted grey and existing line/canvas colors.

Existing sale layout is categories → catalog → receipt. Keep this information architecture, but make it deliberate, larger, cleaner and touch-friendly.

## Non-negotiable invariants

1. **No transaction/business rewrite.** Do not change `PosTransactionEngine`, `TransactionJournal`, payment providers, fiscal providers, ATOL, INPAS, stock, server APIs or sale calculations.
2. Existing methods remain the source of behavior:
   - add/change quantity/clear;
   - customer lookup;
   - club/review/manual discounts;
   - free-price override where rules allow;
   - upsell accept/dismiss;
   - hold receipt;
   - create order;
   - open shift;
   - complete sale;
   - payment device readiness and remote-payment confirmation;
   - commodity receipt printing.
3. Unknown payment/fiscal outcomes must remain blocked/reconciled exactly as before. Redesign must not add retries or bypass disabled states.
4. Existing accepted payment methods are the only methods shown:
   - cash;
   - card;
   - QR / СБП;
   - remote payment when enabled;
   - mixed.
   Do **not** add gift-card or other unsupported payment methods.
5. Do not invent a pre-sale fiscal receipt number. Before completion show “Текущая продажа” / “Новый чек” or equivalent. Actual receipt number appears after successful sale from `CompleteSaleResult.receiptNumber`.
6. No server schema/API change is expected for this DEV.

## Visual language

Use the existing Raspechatka palette and typography. The approved direction is:
- bright Raspechatka green only for selected state, primary CTA, key success/accent;
- white main surfaces;
- light grey canvas/separators;
- graphite text;
- subtle shadows only where hierarchy needs them;
- high information density, but larger readable type and touch targets than today.

### Strict corner rule

For the redesigned sale flow, structural controls are **angular**:
- cards;
- buttons;
- inputs;
- search;
- modals;
- sections;
- action tiles;
- receipt rows/callouts.

Use `border-radius: 0` for those surfaces. Do not reproduce the rounded-card look of the visual exploration.

Semantic circular marks may stay circular only when their shape itself carries meaning (for example tiny online status dot or success check glyph). Do not use rounded rectangles/pills as decoration.

## Architecture decision

Keep business state and mutations in `AppV2.tsx`, but do not make the root component larger. Extract presentational sale UI behind typed props where practical.

Recommended renderer-only additions:
- `SaleWorkspace.tsx` or similarly bounded sale-layout component;
- `sale-workspace.css`;
- `sale-preferences.ts` + focused tests.

No new dependency is required.

### Local workstation preferences

Resizable zone widths and Favorites are **workstation-local UI preferences**, not cashier identity and not OS catalog data.

Store one versioned renderer preference document in local storage, e.g.:
```ts
{
  version: 1,
  layout: { categoriesRatio: number, receiptRatio: number },
  favoriteProductIds: string[]
}
```

Requirements:
- one key for this installed POS profile, not per cashier;
- defensive parse/version fallback;
- invalid/corrupt values reset to safe defaults;
- clamp layout values on every restore;
- stale favorite IDs that no longer exist in the product catalog are ignored/pruned;
- no sync/outbox/server writes for Favorites or widths.

Ratios are preferred over hard px so resizing the window/monitor remains usable. Apply pixel min widths after ratio restore.

## Sale workspace

### 1. Three adjustable zones

Keep exactly three horizontal zones:
1. categories;
2. catalog;
3. current receipt.

Add two visible draggable splitter handles on the two borders. They should look like narrow “grips/tabs” but have a larger invisible hit target suitable for mouse and touch.

Behavior:
- Pointer Events, not mouse-only handlers;
- drag continuously updates the grid;
- persist only valid/clamped result;
- survive app restart;
- same result for every cashier on the workstation;
- no zone can collapse into unusable width.

Suggested constraints may be tuned during implementation, but the catalog must always retain the largest flexible workspace.

Do not zoom the entire app. Use responsive layout/container rules so content gets larger/more useful when a zone gets wider.

### 2. Categories

Remove the system category **“Все”** from user UI.

First item is always **“Избранное”**. After it, show the real catalog categories in their current order.

Do not show:
- category icons;
- item counts beside categories.

Favorite is a UI collection, not a real catalog category.

### 3. Favorites

Each product/service/bundle sale card has a small star action in its top corner:
- inactive star = not favorite;
- active green star = favorite;
- star click toggles favorite and must **not** add the item to cart;
- ordinary card click still adds the item to cart;
- keyboard/accessibility label required.

“Избранное” shows only favorited sale products. Search while Favorites is selected filters within Favorites.

### 4. Catalog toolbar

Keep only the existing search field:
“Товар, услуга, артикул или штрихкод”.

No new filter button, sort UI, image-view toggle or restaurant-oriented affordances.

Preserve F2 focus behavior.

### 5. Product cards

There are no product images. Do not add placeholder images.

Cards should use available width better and feel closer to square/compact tiles than the current narrow cards:
- strong product name;
- large price;
- small stock line only when `stock != null`;
- favorite star;
- no unnecessary decorative metadata.

Existing product type/business semantics stay untouched. If current card metadata is still functionally necessary, keep it secondary; do not change product contracts.

Use CSS grid/container behavior to increase card/text scale at wider catalog widths rather than leave empty space.

## Current receipt

Keep every current action/calculation, but rebuild hierarchy.

### Header

Show “Текущая продажа” (and optionally “Новый чек”). Do not predict next fiscal number.

Replace the small text-only “Очистить” treatment with a larger clear/trash icon action. It must remain accessible with `aria-label/title="Очистить чек"` and disabled on empty receipt.

### Customer

Keep current customer lookup and current club/customer behavior. Make row larger and easier to scan.

### Receipt lines

Keep:
- product name;
- unit price;
- quantity decrement/input/increment;
- line amount;
- existing free-price entry where allowed.

Make type, quantity controls and totals larger/touch-friendly. Preserve fractional quantity behavior already supported by the current input.

### Upsell

Keep current upsell state machine and rules exactly.

Render the active upsell as a green-tinted horizontal recommendation block below receipt lines:
- existing cashier phrase;
- item name and price;
- large add “+” action;
- dismiss “×” action.

No new upsell logic.

### Discounts and totals

Keep current calculation source and current semantic rows:
- club discount when present;
- review count/discount;
- manual additional discount;
- “Без скидок”;
- “Скидка составила”.

Do not duplicate the final total in another decorative section. The most important final total remains on the primary payment button.

### Bottom actions

When shift is open:
- secondary: “Отложить”;
- secondary: “Оформить заказ”;
- primary green: “К оплате · <total>”.

Make all three materially larger than today.

When shift is closed, preserve existing “Открыть смену” behavior.

## Payment modal

Redesign `PaymentModalV2` as a large centered payment workspace, while preserving all existing behavior and safety.

Layout:
- large heading “Выберите способ оплаты”;
- large amount due near top;
- large rectangular method tiles;
- active method clearly green/selected;
- close action;
- context area below methods;
- large final confirm CTA.

Method tiles show only methods enabled by current point rules:
- Наличные;
- Карта;
- QR / СБП;
- Удалённая оплата;
- Смешанная.

### Cash

For cash:
- large “Получено от клиента” input;
- large calculated “Сдача” value;
- below-total values remain exact current calculations;
- confirm disabled when received amount is less than total.

### Card / QR

Keep real terminal readiness checks. Disabled/unready state and explanatory message remain visible. Do not allow payment when terminal is not ready.

### Remote payment

Keep explicit cashier confirmation and note. Do not compress or hide the safety acknowledgement.

### Mixed

Keep existing allocation semantics and exact total validation. Improve layout only.

### Keyboard/safety

Preserve:
- Enter confirms only when `canSubmit`;
- Escape closes only while safe/not busy;
- busy state prevents repeat;
- safety/recovery footnote remains, but can be visually quieter.

## Successful sale overlay

Redesign the already mounted `SaleSuccessOverlay`.

Headline exactly: **“Оплата проведена”**.

Remove:
- “Спасибо за покупку”;
- “ПРОДАЖА ЗАВЕРШЕНА” kicker;
- “Фискальный чек сформирован” informational card;
- old “Товарный чек — по кнопке в Чеках” message;
- any gift/reminder/promotional content.

Show a compact factual summary:
- amount;
- payment method(s);
- change;
- receipt number;
- date and time.

For date/time, prefer actual saved sale details via existing `getSale(result.saleId)`; if that focused lookup fails, the success UI must still render and may fall back to captured completion time.

Actions:
1. primary green: **“Вернуться к продаже”** — closes overlay and returns to empty/new sale;
2. secondary white/angular: **“Напечатать товарный чек”** — call existing `printSale(result.saleId, 'commodity')`.

Printing behavior:
- no new fiscal sale;
- commodity print only;
- on successful print, close the success overlay;
- on print failure, keep overlay open and show a concise error/retry state;
- disable duplicate print click while request is pending.

Enter may remain a shortcut for returning to sale, but the visible second button is commodity receipt printing, not “Enter — новый чек”.

## Responsive/content scaling

The user explicitly wants wider zones to use the extra area, not display empty space.

Implement with local responsive/container rules, not whole-app zoom:
- catalog grid adds columns and can step up name/price font size at larger container widths;
- receipt line text/quantity controls/payment CTA can scale within bounded ranges;
- categories stay readable but compact;
- no key button/text clipping;
- no horizontal overflow at supported POS minimum width.

## Files expected in scope

Primary:
- `pos/src/renderer/src/AppV2.tsx`;
- new/extracted sale workspace component(s);
- new sale workspace preference helper;
- `pos/src/renderer/src/styles.css` and/or `pos-v2.css`;
- `pos/src/renderer/src/PaymentModalV2.tsx`;
- `pos/src/renderer/src/checkout.css`;
- `pos/src/renderer/src/SaleSuccessOverlay.tsx`;
- `pos/src/renderer/src/pilot-ux.css`;
- focused renderer tests.

Read-only unless a proven integration defect requires a tiny change:
- `pos/src/renderer/src/main.tsx`;
- `pos/src/renderer/src/CashierHotkeys.tsx`;
- `pos/src/preload/index.ts`;
- `pos/src/shared/contracts.ts`.

Do not touch main transaction/payment/fiscal code for this redesign.

## Staged implementation

1. **Sale shell + persistence + resizable splitters**
   - extracted presentational shell;
   - sharp visual foundation;
   - versioned local preferences;
   - two PointerEvent splitters;
   - container-responsive sizing.

2. **Categories + Favorites + catalog cards**
   - remove “Все”;
   - “Избранное” first;
   - local favorites;
   - stars;
   - search-only toolbar;
   - no images/counts/icons;
   - larger angular cards.

3. **Receipt UX**
   - larger header/clear action/customer/lines;
   - upsell callout;
   - discounts/totals;
   - hold/order/pay hierarchy;
   - no business-calculation changes.

4. **Payment UX**
   - large angular payment modal/method tiles;
   - cash/change;
   - terminal/remote/mixed safety preserved;
   - focused regression tests.

5. **Success UX + commodity print + integration polish**
   - “Оплата проведена” summary;
   - actual receipt number/date/time;
   - return-to-sale;
   - commodity print from overlay;
   - final focused renderer contracts and keyboard states.

## Acceptance

A task is not complete until:
- all existing sale functions remain available;
- no server/payment/fiscal semantics changed;
- “Все” is absent and “Избранное” is first;
- favorites persist on the workstation and are not per cashier;
- both splitters work with pointer/touch and persist;
- layout survives restart and clamps safely;
- product cards contain no images and no category counts/icons;
- wider regions visibly use space for larger/more useful content;
- receipt keeps customer, quantities, all discount types, upsell, hold, order and payment;
- payment modal is large/readable while existing safety gates still work;
- success overlay says only “Оплата проведена” plus factual sale details and two actions;
- commodity receipt button uses existing safe print path;
- redesigned cards/buttons/inputs/modals are angular, not rounded;
- focused tests pass during parts;
- final POS `npm run typecheck`, `npm test`, `npm run build` run once after all parts;
- Windows packaging is not required unless source/package files outside renderer unexpectedly change.
