# DEV-173 — POS shift, cash count and durable drawer balance

Plans: PLAN-052, PLAN-061, PLAN-066.
Baseline: `version-16@91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Branch: `codex/dev-173-pos-cash-drawer`.
Risk: money/accounting state — safety critical.

## User outcome
Cash physically left in one register survives cashier/shift hand-off. Opening count may be deferred but remains visibly pending; closing count is mandatory and becomes the next opening baseline. Counts always compare against an immutable expected amount.

## Current facts
- Current expected cash is recomputed inside the active shift from opening count + cash sales/returns + deposits/withdrawals.
- Opening count currently sets `expectedMinor = counted total`, making opening delta meaningless.
- Cash operations belong to a shift; blank reason is rewritten to `Без комментария`.
- No durable register-level cash balance exists.
- Shift payment breakdown is a fixed cash/card/qr/remote shape rather than an extensible configured-method source.

## Canonical cash model
1. Introduce a durable local drawer state keyed to the physical POS workplace/register context, not employee. It records the latest trusted physical balance/baseline plus whether an opening count is pending. Use an explicit versioned migration; never initialize an existing installation by silently overwriting real cash with zero.
2. Opening a work shift reads the register baseline. An opening count compares counted against that frozen expected baseline. If cashier closes/skips the opening count, the shift may continue but `opening_count_pending=true` persists across restart/logout and is shown as warning on Shift and Recount actions.
3. Control count compares against a snapshot of expected drawer cash at modal open/save contract; keystrokes never move the baseline.
4. Closing count is mandatory before work-shift close. Successful closing count becomes the durable next baseline for the same physical register. Employee change must not reset it.
5. Cash sale/return/deposit/withdrawal continue to feed expected drawer cash exactly once. Do not duplicate the accounting effect in a second renderer-only balance.
6. Migration must derive the safest baseline from existing latest count/closed shift/current facts where provable; ambiguous legacy installation remains explicitly `opening_count_pending` rather than guessed.

## Other UX/contracts
- Move open/close shift action adjacent to current cashier while preserving `ShiftCoordinator` fiscal/work-shift distinction and recovery.
- Cash deposit/withdrawal reason is optional and may be empty; no placeholder and no synthetic `Без комментария` persistence.
- CashCount rows align denomination → quantity → line total; expected/count/delta are visibly separate.
- Shift payment breakdown must be data-driven from the existing configured/current payment method authority while retaining historical methods that actually occurred. Do not lose old sale payment rows because a method was later disabled.

## Stages
1. Durable drawer state + migration + accounting tests.
2. Shift open/close/opening-pending/mandatory-closing state machine and IPC contracts.
3. CashCount/shift/cash-operation UX with immutable baseline.
4. Payment-method breakdown source + historical compatibility.
5. Integrated cash hand-off/restart/migration regressions.

## Safety/acceptance
Tests must cover cashier A close → cashier B open, restart between states, opening skipped then later counted, closing blocked without count, deposit/withdrawal/sale/return expected balance, duplicate/replayed operations, old DB migration and no accidental zeroing. Payment/fiscal unknown-state logic and KKT shift recovery are frozen. Full CI/package only once after architect final review.