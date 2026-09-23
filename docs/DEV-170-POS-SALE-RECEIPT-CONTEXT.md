# DEV-170 — POS Sale: catalog, receipt and held context

Base: `version-16` @ `91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Plans: PLAN-051, PLAN-053, PLAN-054, PLAN-055.

## Scope and current state

This DEV is renderer/shared-state work for the Sale workplace. In current stable `SaleCatalog.tsx` applies category and text filters together and text matches name/SKU/barcode; it also shows the old placeholder and visible F2 badge. `CurrentReceipt.tsx` contains the service/loyalty block in the receipt footer, secondary explanatory copy and a separate customer removal action. AppV2 customer picker still contains old helper copy. Held receipts persist cart/customer/review/manual discount, but not the explicit lifecycle of an upsell; restore re-enters an eligible state and can choose a different proposal.

## Architecture decisions

1. Text search and scanner lookup are different flows. While a non-empty ordinary search query exists, filter product **name only**, case-insensitively, across the full catalog available to the POS and ignore selected category. Do not mutate selected category; clearing the query restores category filtering. Preserve existing scanner/barcode/SKU path and F2 focus shortcut; only remove the visual F2 badge.
2. Receipt layout has one growing region: item lines. It must have `min-height:0` and own vertical overflow. Service/discount/loyalty region and payment CTA are non-shrinking and have no nested vertical scrollbar.
3. Customer presentation remains contract-compatible. Do not change discount math or customer API. Before selection all right-side controls use one fixed column width. After selection, the same row shows customer name, actual club percent and ruble discount; the name itself reopens the existing picker. Selecting `Розничный покупатель` clears personal customer/discount through existing semantics. Long names truncate.
4. Held-receipt upsell state becomes explicit, serializable and backward-compatible. Persist a small lifecycle such as pending/dismissed/accepted plus the stable proposal identity/data required to restore the same pending proposal. Old held snapshots without this field remain valid. Restore must not rerun eligibility heuristics when a pending proposal was serialized. Accepted/dismissed proposals must not resurrect and repeated hold/restore must not duplicate.

## Stages

1. Catalog search: `pos/src/renderer/src/SaleCatalog.tsx` and focused renderer tests/CSS only.
2. Receipt/customer UX: `pos/src/renderer/src/CurrentReceipt.tsx`, the customer-picker section in `pos/src/renderer/src/AppV2.tsx`, relevant renderer CSS/tests.
3. Held upsell state: `pos/src/shared/contracts.ts`, held-receipt flow in `pos/src/renderer/src/AppV2.tsx`, `pos/src/main/database.ts` only if serialization helpers require it, plus focused tests.

## Acceptance

- Placeholder is exactly `Поиск по наименованию`; no visible F2 badge; F2 still focuses if it did before.
- A query finds a product from another category by name; SKU/barcode text does not become an ordinary name-search match; clearing returns to selected category.
- Only receipt item lines scroll under overflow. Service/customer/reviews/manual-discount rows remain fully visible and payment CTA stays reachable at 1280×720 and 1366×768.
- Secondary copy under `Покупатель`, `Отзывы`, `Доп. скидка` is removed. Picker placeholder is exactly `Введите последние четыре цифры телефона`; obsolete helper/footer explanation is removed.
- Pending upsell survives hold/restore unchanged; dismissed/accepted does not; multiple cycles create no duplicate.

## Invariants / non-goals

No product model, Cart arithmetic, customer contract, discount calculation, TransactionEngine, payment/fiscal provider or backend changes. No PR/merge/deploy in intermediate stages. Final full gate is run once after architect review of all stages.