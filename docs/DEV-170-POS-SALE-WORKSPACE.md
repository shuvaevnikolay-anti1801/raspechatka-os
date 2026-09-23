# DEV-170 — POS sale workspace completion

Plans: PLAN-051, PLAN-053, PLAN-054, PLAN-055.
Baseline: `version-16@91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a` after DEV-169.
Branch: `codex/dev-170-pos-sale-workspace`.

## User outcome
The cashier can find any product by name regardless of category, keep the current receipt usable on laptop-sized screens, use a compact customer/discount service block, and hold/restore a receipt without losing the exact upsell lifecycle.

## Current facts
- `SaleCatalog.tsx` applies category filtering before text search; its placeholder is not the required text and it renders a visible F2 badge.
- `CurrentReceipt.tsx` mixes scrollable lines and service/discount content and contains explanatory secondary copy that PLAN-055 removes.
- `AppV2.tsx` stores held receipt lines/customer/discount state but not upsell lifecycle; restore recomputes upsell eligibility.
- DEV-169 design tokens/primitives and three-zone sale workspace are already stable and must be reused.

## Fixed contracts
1. Text search is global only while query is non-empty and matches product `name` only, case-insensitively. Category selection remains unchanged and resumes when query is cleared. Scanner/SKU/barcode handling outside this display filter remains unchanged.
2. Placeholder is exactly `Поиск по наименованию`; F2 remains a keyboard shortcut but has no visible badge in the field.
3. Held receipt persists explicit upsell lifecycle sufficient to distinguish at least pending/accepted/dismissed. Restore must reproduce that state, not regenerate it from rules heuristically. Old held-receipt JSON without the new field remains readable.
4. Receipt lines are the scroll region. Customer/review/manual-discount/totals/actions remain visible in the fixed service/footer region at 1280×720 and 1366×768.
5. Customer picker placeholder exactly `Введите последние четыре цифры телефона`; no helper prose. Retail customer clears personalization. Selected customer row shows name + percent + ruble discount and can reopen picker.
6. Discount math, protected-item rules, payment/fiscal contracts, cart math and transaction engine are frozen.

## Stages
1. Catalog global name search + F2 visual cleanup.
2. Held-receipt upsell persistence/compatibility.
3. Current receipt service/customer UX and fixed-scroll contract.
4. Laptop adaptive sweep and focused regression coverage.

## Acceptance
Focused renderer/unit tests prove search/category interaction, scanner path non-regression, old/new held receipt compatibility, no duplicate upsell after restore, exact customer copy/clear behavior, fixed service block, and 1280×720/1366×768 layout contracts. No full CI/build/package until architect final review.