# DEV-172 — POS Cash Drawer + Shift

Base: `version-16` @ `91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Plans: PLAN-052, PLAN-061, PLAN-066.

## Current state and problem

`pos/src/main/database.ts` currently derives expected cash from the latest cash count plus later `cash_delta` journal events. Opening cash-count UI in AppV2 sets `expected = total`, so the baseline moves while the cashier types. Shift summary is still shift-centric and payment rows are rendered from a hard-coded set. The requested behavior requires a durable physical-drawer balance that survives employee/shift boundaries and restart.

## Architecture decision

1. Introduce additive local persistence for cash-drawer state keyed by the existing physical POS/point identity used by this installation. The canonical expected drawer balance is not owned by Employee or cashier shift. Migrate existing installs conservatively from the latest durable count plus subsequent journaled cash deltas; if no reliable prior count exists, initialize to the current safe legacy value rather than inventing money.
2. A successful cash count records observed total and becomes the new drawer baseline. Legal journaled cash movements after that count update expected balance. Employee/shift are audit metadata only.
3. Opening shift: capture the expected drawer baseline before editing. Closing the opening count via X may start the shift only if current flow already permits it, but must persist an `opening count missing` flag for the active shift/drawer and surface a warning/badge + recount action until a successful count clears it. Do not silently mark a count complete.
4. Closing shift: final count is mandatory. Cancel/close of the counting modal must leave the shift open. Only a successful final count can continue close-shift flow.
5. CashCountModal uses an immutable `expectedMinor` snapshot for the counting session. `countedMinor` changes from denomination inputs; `differenceMinor = countedMinor - expectedMinor` keeps the existing sign convention. UI row geometry is shared across opening/manual/closing modes.
6. Cash movement `Основание` is optional and has no placeholder; amount remains required. Shift open/close action moves into cashier block under cashier name. Payment summary rows derive from current `PointRules` (`acceptsCash`, `acceptsCard`, `acceptsQr`, `acceptsRemotePayment`) while historical operations remain intact.

## Stages

1. Persistence/contract: `pos/src/main/database.ts`, local migrations in that module, `pos/src/shared/contracts.ts`, narrow IPC/main plumbing in `pos/src/main/index.ts`, focused DB tests.
2. Shift lifecycle safety: AppV2 shift open/close orchestration + database APIs/tests for opening-missing flag and mandatory final count.
3. CashCountModal calculation/layout: cash-count section of `pos/src/renderer/src/AppV2.tsx`, CSS/tests.
4. Shift workplace UX: shift section of AppV2/current shift components, PointRules-driven payment rows, cash reason copy, CSS/tests.

## Safety invariants

Never derive a new baseline from partially typed denomination values. Never close shift after cancelled/failed final count. Never reset expected drawer merely because cashier changes. Cash/fiscal/payment journal events remain authoritative and are not rewritten. Migrations are additive/backward-compatible and idempotent.

## Acceptance

Expected remains fixed while counting; counted/difference update immediately. Closing count persists across restart and next cashier. Opening missing warning survives restart until successful recount. Manual cash movement changes expected exactly once. Disabled payment methods are hidden from current summary without deleting history. Layout acceptance at 1280×720 and 1366×768.

No PR/merge/deploy or full package during intermediate stages.