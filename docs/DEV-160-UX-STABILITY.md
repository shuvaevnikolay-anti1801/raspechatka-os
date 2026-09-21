# DEV-160 — POS and Web OS UX stability: PIN, receipt discounts, list loading, time zones, wide screens

## Status and scope

Target branch: `codex/dev-160-ux-stability` from stable `version-16` at `270ab1a361d7abbed4c031c7842ff12bcc1dfe7b`.

This DEV is a focused quality pass over five user-visible defects discovered on the current Windows POS and Web OS. It does **not** change payment, fiscal, stock, sale persistence, cashier authorization rules, or business formulas beyond preserving already selected receipt discount inputs.

## Verified current defects

1. **Windows POS PIN layout**
   - `CashierLogin` uses one password input painted with a segmented CSS background.
   - `.cashier-pin-input` combines fixed width, padding and `letter-spacing:.56em`; the password glyphs do not align with the four visual cells.
   - `cashier-forgot-pin` is inside the form while `settings-open-trigger` is outside it with `margin-top:auto`, so the two footer links do not share one baseline.
   - The admin code is also a four-digit numeric secret but uses the generic full-width input instead of the same PIN visual language.

2. **Review discount is erased when a customer is selected**
   - `AppV2.chooseCustomer()` currently executes `setReviewCount(0)`.
   - Club discount, review discount and manual discount are separate receipt inputs; changing the customer must only change the customer/club-discount component and then let the canonical discount calculator recompute the combined result.
   - `calculateDiscountBreakdown` remains the canonical cap/order logic.

3. **Web OS list pages visibly load twice**
   - Standard list pages start their own initial `load()`.
   - `SmartFilterBar.loadPreference()` may restore `lastFilters` and then call `apply()`, causing another request.
   - Server-paginated tables may also trigger a request after `SmartDataTable` restores saved page size through `ready`.
   - `SmartDataTable` currently replaces an already-rendered table with a blocking loading placeholder whenever `loading=true`, producing the visible “table → blank/loading → table” jump.

4. **Date/time display has no single contract**
   - Custom Web OS bypasses Frappe Desk date rendering.
   - Current pages mix raw Frappe strings, `new Date(value)`, `new Date(value.replace(" ", "T"))`, local constructors and UTC `toISOString()`.
   - `ClientsPage` table currently renders `registered_at` raw, including seconds.
   - The existing `Business Point` model already has an IANA `timezone` field.
   - Web boot currently exposes no explicit user/system display timezone.

5. **Web OS content is artificially narrow on ultrawide displays**
   - Global `.page` is `width:100%; max-width:1680px; margin:0 auto`, while navigation spans the viewport.
   - This creates large unused side gutters for table/filter workspaces on wide monitors.

## Architecture decisions

### A. POS PIN control

Use one real numeric/password input per four-digit secret for keyboard, Enter-submit, accessibility and paste behavior, but render the visual value as exactly four equal cells. Do not create four independently focusable inputs.

A small reusable `PinInput` (local to POS renderer unless extraction is clearly useful elsewhere) should:
- accept only four digits through the existing normalization;
- expose one actual input with correct `inputMode`, `maxLength` and pattern;
- render four equal visual slots with one centered bullet per entered digit;
- have deterministic focus/error styling;
- be used for normal cashier PIN, new PIN, confirmation and four-digit admin code;
- preserve existing login/setup/reset behavior and Enter/form submit.

Put `Настройки кассы` and conditional `Забыли PIN?` in one explicit footer row: settings left, forgot-PIN right. In reset/setup states where forgot-PIN is not shown, the settings link remains left without layout jumps.

### B. Receipt discount ownership

Receipt discount state is independent by source:
- club/customer discount = derived from selected customer;
- review count = cashier-entered receipt state;
- manual discount = cashier-entered receipt state.

Selecting, replacing or removing a customer must **not clear** review count or manual discount. The canonical calculator recomputes the applied amounts/caps after customer changes.

Do not change:
- order of discount application in `calculateDiscountBreakdown`;
- max discount rules;
- protected-item rule;
- persisted money units;
- payment/fiscal payload semantics.

Focused regression must reproduce: set one review → attach customer → review selection remains and total becomes the valid combination; remove/replace customer → review selection remains. Also cover manual discount retention.

### C. One stable list initialization

`SmartFilterBar` owns restoration of filter preferences; page code owns data loading. Make that handshake explicit.

Required contract:
1. `SmartFilterBar` restores schema/visible fields/bookmarks/last filters.
2. After the model has received the restored filters, it emits a dedicated `ready` event exactly once per `viewKey` initialization. It must not independently cause a second implicit initial fetch.
3. Standard list pages with `SmartFilterBar` start their first row request from this `ready` event, not simultaneously from `onMounted(load)`.
4. Server-paginated pages wait for both filter readiness and `SmartDataTable` saved page-size readiness, then perform exactly one initial row request.
5. User Apply/Reset, page changes and page-size changes continue to perform one request each.
6. A refresh with existing rows should keep the table mounted and show a compact non-blocking “Обновляем…” state; only the first load with no rows uses the full loading placeholder.
7. Guard against stale out-of-order responses where a page can have overlapping reads after filter/page changes (small request generation token is acceptable; AbortController only if it fits the existing `call()` contract without broad API churn).

Known SmartFilterBar consumers to update/audit:
- `CatalogPage.vue`
- `ClientMarketingPage.vue`
- `ClientsPage.vue`
- `EmployeesPage.vue`
- `FinanceBankPage.vue`
- `FinanceCalendarPage.vue`
- `FinancePaymentsPage.vue`
- `FinanceReportPage.vue`
- `MasterDataPage.vue`
- `ReferencesPage.vue`
- `SalesPage.vue`
- `TeamPage.vue`
- `UsersPage.vue`
- `WarehouseDocumentsPage.vue`
- `WarehouseMovementsPage.vue`
- `WarehouseReceiptsPage.vue`
- `WarehouseReportPage.vue`

Do not rewrite page business queries or filter semantics.

### D. Canonical Web OS time policy

Storage is not migrated by this DEV. Existing Frappe `Datetime` fields remain canonical.

Display policy:
1. The browser/OS timezone must never silently be the source of truth.
2. Web boot exposes:
   - system/site timezone from Frappe System Settings;
   - effective user timezone from the logged-in Frappe user preference, falling back to system timezone.
3. Generic Web OS administrative timestamps display in the **effective user timezone**.
4. Explicit point-local operational screens may request/use `Business Point.timezone`; point timezone does not silently override unrelated network/admin timestamps.
5. A future partner/user in another timezone therefore sees timestamps in that user's configured Frappe timezone without changing stored facts. The administrator can have a different timezone.
6. Shared frontend date utilities parse Frappe's timezone-naive datetime using the known site timezone, then format to the requested IANA target timezone. Do not rely on browser-local parsing.
7. Visible standard datetime format: `DD.MM.YYYY HH:mm` (hours and minutes, **no seconds**). Date-only values remain calendar dates and must not shift through UTC conversion.
8. “Today/current month” defaults use the effective display timezone rather than `new Date().toISOString()`, avoiding day/month drift around midnight.
9. `datetime-local` edit controls must round-trip the intended domain time without browser timezone mutation.

Audit/migrate the current inline date logic at minimum in:
- `ClientsPage.vue`
- `FinanceBankPage.vue`
- `FinanceCalendarPage.vue`
- `FinancePaymentsPage.vue`
- `FinancePlanningPage.vue`
- `FinanceReportPage.vue`
- `SalesPage.vue`
- `TeamPage.vue`
- `WarehouseDocumentsPage.vue`
- `WarehouseMovementsPage.vue`
- `WarehouseReceiptsPage.vue`
- `WarehouseReportPage.vue`
- shared `entityListSchema.js` where declarative datetime fields can remove page-local formatters.

The current `Business Point.timezone` field remains authoritative for point-local domain use; do not add a duplicate timezone field.

Focused tests must include:
- same raw Frappe datetime formatted for two different user timezones;
- browser timezone independence;
- no seconds;
- date-only value unchanged;
- current day/month near UTC midnight;
- fallback user timezone → system timezone.

### E. Fluid wide-screen workspace

The Web OS workspace should use the available viewport width on large monitors. Remove the global 1680px ceiling from ordinary `.page` workspaces and keep responsive horizontal padding using a bounded/clamped gutter.

Do not remove intentional local max-widths for text-heavy placeholder/forms/cards. Tables, filters, reports and operational workspaces should be able to grow with the viewport. Preserve current tablet/mobile breakpoints and horizontal scrolling where a table has a real minimum width.

## Delivery parts

1. DEV-160 (1) — POS PIN/login visual geometry.
2. DEV-160 (2) — Receipt discount state retention.
3. DEV-160 (3) — Stable list initialization/no flicker.
4. DEV-160 (4) — System timezone/date formatting contract.
5. DEV-160 (5) — Fluid wide-screen Web OS workspace and final UX regressions.

All parts are sequential in the same branch. No intermediate PR/merge/deploy/full CI. Architect reviews the factual GitHub diff after every part. Full POS/frontend/backend checks, Windows package, one PR, merge and deploy happen once after (5).

## Final acceptance

- All four-digit POS secret fields are visually four equal aligned cells; footer links share one line where both are present.
- Review/manual discounts do not disappear when customer state changes; canonical combined limits still apply.
- Standard list navigation no longer flashes populated table → blocking loader → table, and initial preference restoration does not cause redundant uncontrolled row races.
- Web OS uses one explicit timezone policy and shared formatter; user/system timezone is visible in boot contract; no seconds in normal datetime display.
- Client registration timestamps no longer depend on browser timezone parsing.
- Different users can have different display timezones using Frappe user preference, with system fallback; point timezone remains available for point-local operations.
- Main Web OS workspaces use ultrawide screens instead of stopping at 1680px.
- No changes to payment/fiscal/stock transaction correctness boundaries.
