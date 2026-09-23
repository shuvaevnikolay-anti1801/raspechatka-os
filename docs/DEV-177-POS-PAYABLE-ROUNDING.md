# DEV-177 — Canonical payable rounding

Base: `version-16` @ `91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Plan: PLAN-056.

## Current state

Current Cart/discount calculation has no payable rounding. `TransactionEngine` validates the request payable and requires payment sum to match it; providers/fiscalization consume the transaction snapshot amount. Therefore rounding must be a single canonical amount before payment/fiscal execution, not a provider-specific adjustment.

## Business rule

Final payable is rounded **down to whole rubles** after all existing discounts:
`payableMinor = Math.floor(preRoundFinalMinor / 100) * 100`.
Examples: 42450 -> 42400, 42499 -> 42400, 42400 -> 42400. The non-negative rounding adjustment is `preRoundFinalMinor - payableMinor`.

## Architecture decisions

1. Implement a shared pure money/totals helper that returns the existing pre-round amount, rounding adjustment and canonical payable in integer minor units. Do not use floating point for money.
2. Every downstream boundary uses exactly that canonical payable: Sale CTA, PaymentModal amount, CompleteSaleRequest/TransactionEngine validation, payment provider amount, journal snapshot, persisted sale amount and fiscal receipt total. There must be no second rounding in providers or backend.
3. If rounding adjustment is non-zero, receipt/totals UI shows `Округление` between `Без скидок` and `Скидка составила`. Total customer economy includes both actual discounts and the rounding adjustment. If zero, do not render a fake zero row.
4. Refund/reversal uses the amount that was actually captured/fiscalized/persisted for the original sale. Never recompute a historical refund from current rounding rules.
5. Preserve exact tender reconciliation. Payment sum, fiscal total and persisted sale payable must equal each other to the kopeck (with payable ending in `00`).

## Stages

1. Pure totals model: `pos/src/shared/cart.ts` and focused unit tests. Add explicit fields/helpers without breaking existing callers until stage 2.
2. Canonical propagation: sale orchestration in `pos/src/renderer/src/AppV2.tsx`, PaymentModal/request contracts in `pos/src/shared/contracts.ts`, `pos/src/main/transaction-engine.ts`, journal/persistence call sites and provider/fiscal inputs. Remove any opportunity for divergent amount; focused engine/provider tests.
3. Presentation/reconciliation: `pos/src/renderer/src/CurrentReceipt.tsx`, payment/totals UI and focused renderer/money-matrix tests including discounts, no discount, 0/1/50/99 kopeck tails and refund from stored original amount.

## Safety invariants

All money is integer minor units. Canonical payable is calculated once from authoritative cart totals. Unknown payment/fiscal outcomes retain existing reconciliation behavior. Never compensate a payment/fiscal mismatch by silently changing amount. Historical sales/refunds remain based on stored captured/fiscalized values.

## Acceptance

All examples round down correctly; exact whole-ruble amount is unchanged. Payment provider, fiscal check, journal and persisted sale agree on one amount. UI explains nonzero rounding and economy. Refund of a rounded sale returns the actual original paid amount. Existing discount semantics apart from the new final rounding remain unchanged.

No PR/merge/deploy during intermediate stages; final full POS gate only after architect review.