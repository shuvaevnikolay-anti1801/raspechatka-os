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

## Stage 5 invariant matrix (automated)

| Invariant | Focused coverage |
| --- | --- |
| Cashier identity | `person-name.test.ts` normalizes full and abbreviated Cyrillic names; `atol-json.test.ts` serializes openShift, closeShift, sell and sellReturn through UTF-8 JSONL and checks `Иванова А. С.`. |
| Payable boundaries and discounts | `cart.test.ts` covers 100/101/199/200 kopecks, 1–99 kopeck adjustments, protected items and stacked club/review/manual discounts. |
| Payment source of truth | `transaction-engine.test.ts` covers cash, card, QR, confirmed remote and mixed payments, and rejects mismatched payable or parts before side effects. |
| Fiscal positions | `atol-json.test.ts` covers fractional quantities, 17/19 lines, 1/37/99 kopeck adjustments, service payment object, persisted position amounts and exact payment/item sum; mismatched persisted allocation is rejected. |
| UNKNOWN and restart | `transaction-engine.test.ts` covers bank and fiscal unknown states, hashes across journal restart, blocked repeated actions, and recovery without a second charge or fiscal call. |
| Historical returns | `transaction-engine.test.ts` covers partial then full residual refund from persisted allocation, legacy pre-rounding 199-kopek sale, and quantity/amount over-return rejection. |

## Manual Windows + physical ATOL acceptance (architect/operator)

Prerequisites: Windows x64 POS build; installed official ATOL Driver 10 x64; real registered KKT/FN and INPAS test arrangement where applicable. Record POS commit, package version, Driver version, configured KKT serial and shift/FN document numbers. Use test transactions under the authorized fiscal procedure.

1. Connect the selected KKT and confirm POS health reads its **configured serial number**. Do not substitute another connected device.
2. With cashier `Иванова Анна Сергеевна`, open the fiscal shift. Check printed/FN operator is readable as `Иванова А. С.`; retain shift/document evidence.
3. Sell a basket with a 1–99 kopeck adjustment, fractional quantity and multiple lines. Include cash/card or other enabled mixed payments. Before payment, record discounted total, separate rounding adjustment and displayed payable. Compare terminal charge(s), local sale/payments/outbox, server mirror, printed/FN receipt total, receipt payment sums and receipt position sums: **all payable amounts equal to the kopeck; ordinary discounts exclude the rounding adjustment**. Check tax and product/service payment objects.
4. Refund part of a paid line; check the amount uses its persisted allocation. Refund the remaining quantity; check the two refunds together do not exceed the original fiscal and payment totals. Where a pre-DEV-176 sale is available, refund it from its original stored amount without recalculating today's rounding.
5. Verify `Иванова А. С.` is readable on sale and return receipts. Close the fiscal shift and check the same operator is readable on the close-shift document. Compare POS/FN document numbers and signs.
6. In a controlled test, disconnect USB or terminate POS at the fiscal call boundary. Before reconnecting, note the FN document number and transaction evidence. On restart the operation must remain UNKNOWN/blocked when the outcome cannot be proven. Reconnect only the same serial; reconcile using FN evidence. Confirm **exactly one** fiscal sale/return document for the operation; do not repeat while UNKNOWN. Repeat at a payment/INPAS boundary if the test setup permits, and check no second charge. Reprint must create no new fiscal document.

Record PASS/FAIL and evidence for every step (receipt/FN identifiers, amount in kopecks, terminal transaction ID if used, screenshots/logs without personal data). A failed equality, unreadable Cyrillic, wrong KKT serial or duplicate document blocks physical acceptance. Automated tests and typecheck alone do not constitute hardware acceptance.
