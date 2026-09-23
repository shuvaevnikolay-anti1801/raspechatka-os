# DEV-176 — fiscal operator identity and authoritative rounded payable

Plans: PLAN-050, PLAN-056.
Baseline: `version-16@91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Branch: `codex/dev-176-pos-fiscal-totals`.
Risk: money + fiscalization + returns + real ATOL hardware.

Read `pos/DEV-151-ATOL-DRIVER.md` before every ATOL/provider stage.

## User outcome
ATOL receives the real cashier as `Фамилия И. О.` without Cyrillic corruption, and the amount the cashier sees, charges, journals, fiscalizes and later refunds is one identical ruble-rounded amount.

## Current facts
- `index.ts` passes raw employee/shift name as `currentOperator`; `atol-json.ts` only trims it and Driver/Web paths share the builder.
- TransactionEngine currently treats `calculateDiscountBreakdown(...).totalMinor` as authoritative amount through journal/payment/fiscal flow.
- ATOL JSON allocation already forces fiscal item sums to equal provided total; server receipt ingestion also allocates line totals to payload total.
- No explicit rounding adjustment exists in the shared discount breakdown.

## Operator contract
1. Create one main/shared-safe person-name formatter producing `Фамилия И. О.` from the existing full employee name, tolerant of missing patronymic/extra spaces. Renderer may reuse it, but main process must not import renderer code.
2. `currentOperator` supplies the formatted cashier consistently for KKT openShift, closeShift, sale and return. Do not transliterate Cyrillic.
3. Audit Electron → JSON serialization → TS bridge → JSONL stdin/stdout → .NET Console/JSON → late-bound Driver 10 `processJson` path. All text transport is UTF-8; stdout remains protocol-only and stderr/logs diagnostic. Fix only a proven encoding defect. Add transport-level Cyrillic regression where testable.

## Money contract
1. Compute ordinary discounts first. Canonical payable is `floor(discountedTotalMinor / 100) * 100`.
2. Add explicit non-negative `roundingAdjustmentMinor = discountedTotalMinor - payableMinor`. It is not club/review/manual discount and does not alter configured discount caps.
3. UI hierarchy when nonzero: `Без скидок` → `Округление` → `Скидка составила` → `К оплате`. Ordinary discount reporting remains semantically separate.
4. One authoritative payable flows through Sale CTA, PaymentModal allocations, CompleteSaleRequest, TransactionEngine operation/journal, payment provider request, local sale/payment persistence, outbox/server receipt and FiscalProvider amount. No component recomputes a different total.
5. Fiscal line allocation must sum exactly to payable and remain valid for fractional quantities/taxes. Payment sum must equal payable exactly.
6. Returns use the actually paid/fiscalized persisted sale total and allocated persisted line values. Never recalculate historical payable with current rounding rules. Partial returns remain bounded by original paid/fiscalized amount and payment evidence.
7. UNKNOWN payment/fiscal outcomes, recovery hashes/evidence and no-blind-retry invariants are unchanged.

## Stages
1. Shared operator formatter + all ATOL operator call sites + UTF-8 bridge regression.
2. Shared discount/payable/rounding contract + Sale UI.
3. Payment/journal/TransactionEngine/local persistence use the single payable.
4. Fiscal/server receipt allocation + returns/recovery consistency.
5. Focused end-to-end automated matrix and Windows/ATOL physical acceptance checklist.

## Acceptance
Test exact values around kopeck/ruble boundaries, multiple discounts, mixed payments, fractional quantities, sale/restart/recovery, full/partial returns and item-total reconciliation. Final DEV is not done until Windows package passes and physical ATOL proves readable Cyrillic operator on shift/sale/return and fiscal totals equal charged totals. No PR/merge/deploy during intermediate stages.