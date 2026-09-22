# DEV-169 — Windows POS Design System + full adaptive UI migration

Branch: `codex/dev-169-pos-design-system`  
Base: `version-16@2221b83d65e1fd0edf55f9f37e019b32c9558bf5`

## Product decision

This is **not** a redesign from zero. The current Windows POS information architecture and business flows remain. The goal is to turn the current renderer into one coherent Raspechatka POS design system and migrate every actually reachable page/modal/state to it.

The permanent visual source of truth is the Google Sheet tab **«Дизайн-код Касса»** in `Архитектор ОС`. This spec mirrors the implementation-relevant rules so coding does not depend on guessing.

## Brand / visual contract

- Brand accent for Windows POS: **#BAFF32**.
- Light desktop work theme: warm canvas + white surfaces + graphite/near-black text.
- Structural geometry is angular: default structural radius = 0.
- Green is scarce and meaningful: active/selected/primary/positive brand signal, not “every button”.
- Secondary actions are quiet white/light surfaces with border and graphite text.
- Destructive actions use one restrained danger token.
- Inter / Segoe UI fallback remains the working font stack until an explicit brand desktop font is provided.
- Obvious repeated actions use semantic icons; do not use random Unicode/emoji as the permanent icon system.
- No new UI/component/icon dependency.

## POS-only theming boundary

`shared/raspechatka-theme.css` is imported by both Windows POS and Web OS. **Do not change shared theme semantics for this DEV.**

Create a POS-only design layer under `pos/src/renderer/src/**`, imported only by the Electron renderer. It may:
- define `--pos-*` tokens;
- locally alias/override `--rp-green` to the POS brand lime for this renderer;
- locally set structural radius to zero;
- provide shared primitives and responsive rules.

It must not visually change Web OS.

## Exact foundation tokens

Implement the following as POS-owned tokens rather than repeated literals.

### Color
- brand/accent: `#BAFF32`
- ink: `#11130F`
- graphite: `#1E201C`
- canvas: `#F3F2EB`
- surface: `#FFFFFF`
- muted / borders / danger / warning: one named token each; choose restrained values during stage (1), then do not introduce local alternatives later.

### Type scale
- meta: 10px
- label: 12px
- body/control: 14px
- strong: 16px
- section title: 18–20px
- modal title: 24px
- page title: 28px
- primary money/KPI: 30–32px
- responsive `clamp()` is allowed for page titles / KPI only.
- no visible working text below 10px.

### Weight
Use a small role set around regular / medium / strong. Do not create local boldness just to compensate for weak hierarchy.

### Spacing
Canonical spacing scale: **4 / 8 / 12 / 16 / 20 / 24 / 32 px**.

### Controls
- compact/icon action: 40px;
- ordinary input / secondary action: 44px;
- frequent / primary touch action: >=48px;
- payment method tiles may be larger.

### Geometry/depth
- structural radius: 0;
- one base border, one stronger border;
- one light modal/elevation shadow;
- circles only where shape itself is semantic (status dot, spinner, radio-like indicator).

## Desktop adaptive contract

Windows POS is desktop-only, not mobile-first.

### Supported bands
- hard lower width boundary remains 1100px unless a later hardware profile changes it;
- compact desktop: 1100–1279;
- standard: 1280–1599;
- wide: 1600+;
- short-height mode: height <= ~760px.

### Mandatory acceptance matrix
Every migrated significant surface must be checked at:
- 1280×720;
- 1366×768;
- 1440×900;
- 1920×1080;
- plus 1100px-wide compact boundary.

### Adaptive rules
- prefer `minmax()`, `clamp()`, auto-fit/auto-fill and bounded columns;
- do not stretch semantic form/status blocks indefinitely on wide screens;
- at short height reduce vertical whitespace first, not core text/touch size;
- critical modal title/summary/primary CTA must not become inaccessible because of layout;
- scroll is acceptable for genuinely long data regions (orders/receipts/logs/product lists), not as a workaround for broken core modal composition;
- acceptance includes long product names, long employee/supplier names, comments, large money values, empty/error/disabled/loading states.

## Shared primitives

Create a small native POS UI layer, no third-party library. Preferred location: `pos/src/renderer/src/ui/**`.

Required contracts:
1. **PosIcon**
   - inline SVG, `currentColor`;
   - semantic icons for Sale, Receipts, Orders, Shift, Work, Settings and common actions: search, refresh, lock, trash/delete, hold, order, close, star/favorite, inventory/box, plus/minus where appropriate;
   - deterministic Windows rendering; no permanent emoji-based icon system.

2. **PosButton / PosIconButton**
   - variants at minimum: primary, secondary, danger, quiet;
   - size roles derived from design tokens;
   - accessible label/title for icon-only actions.

3. **PosModal**
   - one shell: title, close, body, footer;
   - no decorative eyebrow by default;
   - variants/layout contracts: `form`, `action`, `matrix`;
   - header/critical footer remain accessible while a genuinely long body region scrolls.

4. **PosField**
   - shared label/control/error/helper contract for input/select/textarea/date/number;
   - same font, border, padding, focus and error language;
   - textarea can have a larger size variant.

5. Repeatable presentation patterns
   - KPI/stat;
   - status/notice severity;
   - empty state;
   - compact metadata/badge.
   These may be small React primitives or strongly shared CSS contracts; do not over-engineer.

## Runtime scope inventory

The mounted renderer is `AppV2` plus:
- `SettingsHub`;
- `ShiftCloseGuard`;
- `SaleSuccessOverlay`.

Reachable major surfaces:
- cashier login / lock / PIN reset;
- global shell/navigation/status/actions/toast;
- Sale: categories, catalog, current receipt, upsell, loyalty/discount service rows;
- Receipts;
- Orders;
- Shift;
- Work → schedule;
- Work → warehouse + receive/write-off/supply-request modals;
- Settings gate + SettingsHub sections;
- Payment;
- Order modal;
- Return modal;
- cash deposit/withdrawal;
- customer selection;
- manual discount;
- price override;
- cash count;
- shift discrepancy modal;
- sale success overlay.

Do not spend this DEV redesigning old `App.tsx` or unmounted pilot/safety components unless a real runtime reference is proven.

## Business invariants — all stages

UI migration only unless a requirement below explicitly says otherwise.

Do not change:
- TransactionEngine / TransactionJournal;
- payment/fiscal providers or unknown-result safety;
- payment method eligibility / `canSubmit`;
- receipt/cart/discount calculations;
- work-shift business rules;
- PIN/auth/authorization semantics;
- IPC/shared contracts;
- sync/outbox behavior;
- order/warehouse/fiscal/payment persistence;
- ATOL/INPAS behavior.

A functional defect discovered during visual work is reported separately unless it is a tiny renderer validation already explicitly required by Design Code.

## Stage DEV-169 (1) — POS foundation + adaptive shell

Primary files:
- new `pos/src/renderer/src/pos-design-system.css`;
- new `pos/src/renderer/src/ui/PosIcon.tsx`;
- new minimal button/modal/field primitives under `ui/**`;
- `pos/src/renderer/src/main.tsx`;
- `pos/src/renderer/src/AppV2.tsx` — shell/nav/loading/toast + CashierLogin only;
- `pos/src/renderer/src/PinEntry.tsx`;
- `pos/src/renderer/src/styles.css` / `pos-v2.css` only shell/login conflicts;
- focused contract tests.

Requirements:
1. Implement POS-only tokens and the desktop width/height bands above. Shared Web OS theme remains unchanged.
2. Import the POS design-system layer into the renderer. It must contain tokens/primitives/adaptive foundation, not a giant page-specific override dump.
3. Implement SVG `PosIcon`; replace shell Unicode icons with semantic icons.
4. Migrate top navigation, connection indicator, lock/refresh actions, loading/toast, cashier login/PIN footer/actions to foundation tokens/primitives.
5. Keep navigation structure/labels/badges and all auth behavior unchanged.
6. Active/current section uses brand lime. Badges use the same canonical brand token.
7. Header must remain usable through compact/standard/wide bands without clipping essential actions. On compact desktop, reduce gaps/padding before hiding information.
8. Preserve PIN one-input/four-slot keyboard semantics and success/error semantics.
9. Add focused tests for semantic nav icon mapping, variants/accessibility labels and unchanged auth actions.
10. No full test/build/package in intermediate stage.

## Stage DEV-169 (2) — flagship Sale surface

Primary files:
- `SaleWorkspace.tsx`;
- `SaleCatalog.tsx`;
- `CurrentReceipt.tsx`;
- `SaleSuccessOverlay.tsx`;
- `sale-workspace.css`;
- Sale-related rules in `styles.css`, `pos-v2.css`, `cashier-cleanup.css`;
- sale/favorites/receipt/success focused tests.

Requirements:
1. Preserve 3-zone sale layout and splitter persistence.
2. Categories remain left; increase readability through type/control tokens without turning them into oversized navigation.
3. Product card:
   - rectangular/light;
   - name and price use different type roles;
   - favorite star becomes a quiet icon action with no heavy square visual;
   - stock becomes inventory icon + number in a fixed metadata position; do not repeat word “Остаток”;
   - cards with/without stock keep aligned price geometry;
   - long names never overlap controls.
4. Receipt:
   - one heading only; remove duplicate `НОВЫЙ ЧЕК / Текущая продажа` hierarchy;
   - receipt-level actions (hold/delete/create order) are grouped logically at header level, preferably compact semantic icon actions when unambiguous;
   - customer identity moves into the loyalty/discount service area rather than above the line list;
   - each receipt item max two textual rows: name; unit price × qty = total, with compact qty controls integrated into that geometry;
   - customer/reviews/manual discount use one repeatable service-row pattern;
   - one dominant final CTA: `К оплате · amount`;
   - upsell uses brand lime; cashier phrase is primary; item/price/action is one secondary composition.
5. Success overlay uses shared action/modal language and brand tokens without changing print behavior.
6. Adaptive: splitters remain usable; compact desktop keeps receipt operational; wide desktop does not make receipt absurdly wide.
7. Remove/scope conflicting legacy Sale `!important` rules instead of adding more.
8. Business calculations/actions frozen.

## Stage DEV-169 (3) — shared modal system + payment/cash count

Primary files:
- `PaymentModalV2.tsx`;
- inline AppV2 modals: Order, Return, CashOperation, Customer, ManualDiscount, PriceOverride, CashCount;
- `ShiftCloseGuard.tsx`;
- `checkout.css`;
- relevant modal/cash-count rules in existing CSS;
- focused payment/AppV2 tests.

Requirements:
1. Migrate every mounted modal in this stage to one `PosModal` shell and shared field/button semantics.
2. Remove decorative/redundant eyebrow copy unless it carries unique operational meaning.
3. Order modal:
   - one title “Оформить заказ”;
   - remove redundant explanatory copy from the permanent body;
   - compact field grouping;
   - description gets materially more space than phone/date;
   - retain required business fields and payment transition.
4. Phone input keeps/gets real completeness validation consistent with current business requirement; do not accept an obviously incomplete formatted phone.
5. Payment:
   - one title “Выберите способ оплаты”;
   - no permanent Enter/Esc/safety footnote;
   - amount is the primary numeric anchor;
   - large equal payment tiles;
   - explicit selected/disabled/unavailable visual states;
   - method-specific details only when relevant;
   - ordinary cash/card/QR flow fits 1280×720 and 1366×768 without internal modal scroll;
   - one primary CTA. Use action copy `Оплатить · amount` unless code semantics prove a more accurate safe verb is needed;
   - preserve all current terminal/remote/mixed/busy/keyboard safety.
6. Cash count:
   - one title;
   - rows form a clear matrix: denomination badge → quantity → line total;
   - either one vertical list or two perfectly mirrored columns, chosen for viewport fit;
   - consistent row rhythm;
   - summary tiles share one contract;
   - difference=0 positive/brand; non-zero danger;
   - primary save/close action prominent.
7. Return/cash-operation/customer/discount/price/discrepancy modals follow the same modal/field/button system without business changes.
8. Short-height mode must reflow first; core actions cannot disappear behind accidental scroll.
9. Focused tests preserve all money/auth/shift guards.

## Stage DEV-169 (4) — Shift + Receipts + Orders

Primary files:
- `AppV2.tsx` — Shift branch + shared Page/Metric/Empty helpers only;
- `ReceiptsPage.tsx`;
- `OrdersPage.tsx`;
- associated scoped CSS;
- focused contract tests.

Shift:
1. Keep existing information architecture.
2. KPI cards use available space: label secondary, value large/numeric, consistent type roles.
3. Cashier block uses one typography system.
4. Frequent cash actions move closer to cashier/cash context; ordinary actions are secondary white/light controls.
5. Close shift uses one restrained danger variant.
6. Payment rows become readable and aligned; empty cash-movement state is normal readable body text.

Receipts / Orders:
7. Apply page title, toolbar/filter, list/table/card, status, empty/loading and action primitives consistently.
8. Data-heavy lists may scroll in their data region; top actions/status remain stable.
9. Preserve restore/return/order status/update behavior exactly.
10. Responsive columns may collapse/reorder secondary metadata at compact desktop, but must never hide the primary identity/status/action required to work.

## Stage DEV-169 (5) — Work / schedule / warehouse

Primary files:
- `WorkPage.tsx`;
- `workplace.css`;
- focused WorkPage tests.

Requirements:
1. Keep schedule/warehouse business behavior and existing short-name/shift-color semantics.
2. Apply POS type/spacing/button/field/status patterns.
3. Schedule remains dense but readable; employee/day grid and upcoming shifts scale between compact and wide desktop without microscopic text.
4. Warehouse top actions, deliveries, stock list and the three operational modals use the same primitives established earlier.
5. Do not change warehouse payloads, validation, sync or inventory behavior.
6. Remove page-local visual exceptions that duplicate the foundation.

## Stage DEV-169 (6) — Settings + system surfaces

Primary files:
- `SettingsHub.tsx`;
- `settings-hub.css`;
- Settings admin gate;
- any currently mounted global/system notice styles required for consistency;
- focused SettingsHub tests.

Requirements:
1. Preserve all current settings sections/behavior and admin gate.
2. Status cards, forms, toggles, actions, warnings, recovery list and diagnostics follow the same type/spacing/field/button/status language.
3. Long technical forms use bounded responsive columns:
   - compact desktop may use one column;
   - standard/wide can use 2 columns where labels/inputs remain readable;
   - do not stretch short inputs across the entire monitor.
4. Technical diagnostics/log lists may scroll; section headers/actions remain usable.
5. No resurrection of removed Shift status tile or legacy visible Web Requests assistant.
6. No provider/runtime compatibility changes.

## Stage DEV-169 (7) — final adaptive / consistency sweep

Read all renderer CSS and only the runtime-reachable renderer components.

Requirements:
1. Audit every reachable screen/modal/state against Design Code CASA.
2. Remove/scope obsolete duplicate selectors and `!important` created by old visual layers.
3. Consolidate media queries to the desktop strategy:
   - compact 1100–1279;
   - standard default;
   - wide 1600+;
   - short height <= ~760.
   Small-width rules may remain only for a proven desktop-window edge case; remove unreachable phone-layout rules for migrated runtime UI.
4. Search for:
   - local greens instead of tokens;
   - structural non-zero radii;
   - visible text <10px;
   - accidental emoji/Unicode icons in shared navigation/actions;
   - duplicate modal shells;
   - mismatched button/field heights;
   - page-specific shadows/borders that duplicate tokens.
5. Verify the full desktop acceptance matrix and long-data/empty/error/disabled/loading states. No critical layout overflow.
6. Do not touch backend/business contracts.
7. Final only:
   - `npm run typecheck`;
   - `npm test`;
   - `npm run build`;
   - `npm run package:win`;
   - one PR into `version-16`;
   - Windows hardware/manual visual acceptance remains separate.

## Whole-DEV Definition of Done

- Every runtime-reachable Windows POS page/modal uses one coherent Raspechatka visual language.
- The brand accent visible in POS is #BAFF32, not multiple unrelated greens.
- Structural UI is angular and lightweight.
- Repeated controls have consistent type, spacing, height, border, focus, status and action hierarchy.
- Semantic SVG icons replace random navigation/action glyphs where appropriate.
- Sale is fast to scan; receipt has one dominant payment CTA.
- Payment/cash count/order and other modals form one modal family.
- Shift/Receipts/Orders/Work/Settings look like the same product.
- Desktop adaptation works from the 1100px compact boundary through Full HD, with explicit 720/768px height handling.
- Web OS visual theme is unchanged by this POS-only migration.
- No payment/fiscal/auth/sync/order/stock business semantics were weakened.
- Legacy CSS complexity decreases rather than gaining another permanent override layer.
