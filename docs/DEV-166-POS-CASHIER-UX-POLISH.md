# DEV-166 — Windows POS cashier UX polish after real-workstation acceptance

Branch: `codex/dev-166-pos-cashier-ux`  
Base: `version-16@3566a5f119676ab6539d29336d847ae631710c2e`

## Why this DEV exists

DEV-162/163 are functionally present on a real Windows POS, but manual acceptance on 2026-09-22 exposed visual regressions and inconsistent hierarchy. This DEV is a renderer-only polish of cashier-facing system screens, sale workspace and payment. It must preserve every current business rule and external-operation safety boundary.

Do not redesign Work → schedule/warehouse here; that is DEV-167.
Do not change POS→OS document synchronization here; that is DEV-168.

## Non-negotiable invariants

- No change to TransactionEngine, TransactionJournal, FiscalProvider, ATOL fiscal execution, INPAS/payment providers, order/warehouse business contracts, stock math or server APIs.
- Existing cashier auth, PIN verification/reset permissions, work-shift ownership, payment readiness, remote-payment confirmation, mixed-payment totals and unknown-result recovery stay exact.
- Existing sale functionality remains: Favorites/categories/search, cart quantities, customer, free price, club/review/manual discounts, upsell, hold, order, open shift, pay.
- No product images.
- Structural surfaces stay angular: cards, buttons, inputs, modals, sections use `border-radius:0`; semantic dots/check glyphs may remain round.
- Use the current Raspechatka palette: white, grey, graphite, `--rp-green`.
- Do not add new dependencies.

## Current verified implementation facts

### PIN

- Shared `PinInput` / `PinEntryLayout` already exist in `pos/src/renderer/src/PinEntry.tsx`.
- Cashier PIN content is rendered from `AppV2.tsx::CashierLogin`.
- PIN slots are 72px high, fields container is ~360px, but surrounding labels use generic card label alignment, so labels do not share the same left edge as the PIN rectangle.
- Successful PIN reset currently calls `setError('PIN изменён. Теперь войдите с новым PIN.')`; `.cashier-login-error` is red. Success and error need separate severity/state.

### Settings

- `SettingsHub.tsx` status grid currently includes OS / ККТ / Эквайринг / Принтер / Смена. The “Смена” tile is redundant in this technical status block.
- Direct Driver 10 settings are already the normal KKT UI.
- The visible historical “Первичная настройка Web Requests / Настроить АТОЛ 1Ф автоматически” block is not in SettingsHub itself. It is injected by separately mounted `AtolSetupAssistant.tsx` when legacy adapter=`web`.
- Per `pos/DEV-151-ATOL-DRIVER.md`, hidden Web adapter compatibility must remain. Remove the obsolete visible assistant, not the backend fallback or migration compatibility.

### Cash count

- `CashCountModal` is currently inline in `AppV2.tsx`.
- Logic is correct and uses existing denomination values / expected / counted / difference.
- Current CSS in `styles.css` is too small: rows ~40px, inputs 32px, labels/reconcile text ~9px despite available modal space.

### Sale catalog

- `SaleCatalog.tsx` already has Favorites, separate star button, no images, name/price/stock.
- `sale-workspace.css` currently forces near-square tiles via `aspect-ratio:1.12/1` and large min heights.
- Long apparel/product names make cards visually unstable.
- Legacy `cashier-cleanup.css` still contains broad `!important` sale overrides (including product/footer typography and hiding receipt heading) which can override DEV-162 styles. Do not add another layer of `!important`; retire/scope conflicting legacy selectors.

### Receipt

- `CurrentReceipt.tsx` contains the full current business UI.
- The upsell `cashierPhrase` is the sentence the cashier must say to the customer, but current CSS makes it smaller than secondary product/label text.
- Manual-discount action looks like a generic grey button and needs the same POS visual language.
- Preserve all calculations and handlers; this is hierarchy/spacing only.

### Payment

- `PaymentModalV2.tsx` already enforces terminal readiness, cash underpayment, remote explicit confirmation, exact mixed payment, busy duplicate block, Enter/Escape safety.
- `checkout.css` uses a 5-column method grid up to 840px breakpoint, which is cramped on a normal POS laptop and can force awkward scroll/composition.
- Redesign layout only.

## Stage DEV-166 (1) — PIN hierarchy and success states

Primary files:
- `pos/src/renderer/src/PinEntry.tsx`
- `pos/src/renderer/src/AppV2.tsx` — `CashierLogin` only
- `pos/src/renderer/src/pos-v2.css` — PIN/login rules only
- `pos/src/renderer/src/settings-hub.css` — admin PIN alignment only
- focused renderer/auth tests

Requirements:
1. Keep one real input + four visual slots and all existing keyboard/form behavior.
2. Introduce a shared PIN content width/alignment contract so heading/field labels such as “PIN кассира · 4 цифры”, “Код администратора”, “Новый PIN” start on the same left edge as the PIN rectangle.
3. Increase intentional vertical spacing between PIN heading/label and slots; do not make the entire card sparse.
4. Apply the same alignment to cashier login/unlock/reset and Settings admin gate.
5. Replace overloaded error string state with explicit visual severity or separate success notice. Wrong PIN/admin failures remain red. “PIN изменён. Теперь войдите с новым PIN.” is a green success notice.
6. Preserve locked cashier switch/forgot-PIN behavior from DEV-163.
7. Focused tests: success uses success class/state, errors remain error; shared alignment classes; four-slot input; reset/auth handlers unchanged.

## Stage DEV-166 (2) — Settings cleanup and large cash count

Primary files:
- `pos/src/renderer/src/SettingsHub.tsx`
- `pos/src/renderer/src/AtolSetupAssistant.tsx`
- `pos/src/renderer/src/main.tsx`
- `pos/src/renderer/src/AppV2.tsx` — CashCountModal only
- `pos/src/renderer/src/styles.css` / focused cash-count stylesheet
- `pos/src/renderer/src/settings-hub.css`
- `pos/DEV-151-ATOL-DRIVER.md` read-only architecture authority
- focused tests

Settings:
1. Status grid ends at Printer: OS / ККТ / Эквайринг / Принтер. Remove only the visual “Смена” tile; do not delete device shift state from shared contracts if used elsewhere.
2. Remove the visible legacy Web Requests setup assistant from the renderer. Remove its mount/import from `main.tsx`; delete `AtolSetupAssistant.tsx` if no remaining references.
3. Do NOT remove `adapter:'web'`, `atol-web`, Web settings migration, provider fallback, or legacy runtime support. DEV-151 explicitly requires hidden legacy fallback.
4. Direct Driver 10 section remains unchanged except for normal visual consistency.

Cash count:
5. Preserve denomination list, exact total math, expected/difference semantics and open/control/closing behavior.
6. Make denomination rows materially larger and touch-readable. Denomination, quantity input and line amount must use the available modal width.
7. Target minimum touch/input height ~48px; increase typography to normal cashier-readable sizes. Optional +/- steppers are allowed only if they call the same integer quantity state and do not remove direct keyboard entry.
8. Reconcile cards and final save/close action should be readable without tiny 9px text.
9. Ensure common POS laptop viewport (1280×720 and 1366×768) does not make core cash-count controls unusably small.
10. Focused tests: statusItems no Shift; no visible Web Requests assistant/mount; cash-count denomination math unchanged.

## Stage DEV-166 (3) — resilient catalog + receipt hierarchy

Primary files:
- `pos/src/renderer/src/SaleCatalog.tsx`
- `pos/src/renderer/src/CurrentReceipt.tsx`
- `pos/src/renderer/src/sale-workspace.css`
- `pos/src/renderer/src/styles.css` sale selectors only
- `pos/src/renderer/src/pos-v2.css` sale selectors only
- `pos/src/renderer/src/cashier-cleanup.css` only conflicting sale selectors
- existing sale/receipt focused tests

Catalog:
1. Replace near-square product tiles with compact rectangular tiles closer to the pre-DEV-162 proportion. Do not reintroduce product images.
2. Remove forced square aspect-ratio. Use stable min/max height and responsive grid columns.
3. Long names wrap or line-clamp deterministically; they must never overlap star, price or stock.
4. Star stays fixed top-right and remains a separate action that never adds the item.
5. Price has a stable visual anchor near the bottom; stock is secondary and shown only when available.
6. Many similarly named apparel/variant products must remain scannable at laptop width.
7. Favorites/search/category behavior remains exactly current.

CSS cleanup:
8. Audit `cashier-cleanup.css` sale selectors that override new components via `!important`. Remove or scope only obsolete conflicting sale overrides; do not make a repo-wide CSS rewrite.

Receipt:
9. Keep the current logical order and all actions but restore a calmer density: product rows, quantities, totals and bottom actions must align without oversized/undersized jumps.
10. The upsell cashierPhrase is the primary message: make it the largest/most prominent copy in the green recommendation block. “ПРЕДЛОЖИТЕ ПОКУПАТЕЛЮ” is a small label; item/price are secondary.
11. Style the manual-discount button as an intentional POS secondary action, not a generic grey browser control.
12. Keep “К оплате · <amount>” the strongest final CTA.
13. Focused tests: long product-name structure; star isolation; all receipt actions/discount rows remain; upsell phrase has dedicated primary class; no business calculation change.

## Stage DEV-166 (4) — payment modal responsive composition

Primary files:
- `pos/src/renderer/src/PaymentModalV2.tsx`
- `pos/src/renderer/src/checkout.css`
- existing payment renderer tests

Requirements:
1. Keep all payment semantics and `canSubmit` logic byte-for-byte equivalent unless a refactor is required for rendering.
2. Recompose the modal for a POS laptop: large title/amount, large method tiles, context, one obvious confirm button.
3. Do not force five cramped columns. Use a responsive 2–3 column/auto-fit composition with consistent tile size so labels such as “Удалённая оплата” fit naturally.
4. Prefer the modal fitting the viewport without internal scroll for ordinary cash/card/QR cases at 1280×720 and 1366×768. Remote/mixed may grow, but header/method selection/confirm must remain usable.
5. Cash received and change remain large and side-by-side when width permits, stacked when narrow.
6. Terminal-unavailable messages, remote confirmation and mixed allocation remain visible and unskippable.
7. Structural shapes remain angular.
8. Focused regressions: method visibility by rules; terminal disabled; cash underpayment; remote confirmation; mixed exact total; busy duplicate block; Enter/Escape.

## Whole-DEV acceptance

- PIN screens visually align to their four-slot control and successful PIN reset is green.
- Settings status has four technical tiles and no visible Web Requests setup block while hidden legacy Web runtime remains intact.
- Cash count is comfortably usable by touch/keyboard.
- Product tiles are rectangular, stable with long names, and never overlap.
- Receipt hierarchy is readable; upsell phrase is the primary text; discount action matches POS style.
- Payment methods and amount fit cleanly on POS laptop sizes without weakening safety.
- All sale/payment/auth business tests remain green.
- Final only: POS `npm run typecheck`, `npm test`, `npm run build`; one PR into version-16 after all four parts are independently reviewed.
