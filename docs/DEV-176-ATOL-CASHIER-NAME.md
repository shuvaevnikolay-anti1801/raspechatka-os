# DEV-176 — ATOL cashier name and Cyrillic path

Base: `version-16` @ `91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Plan: PLAN-050.

## Verified current state

Renderer already has `formatPersonShortName` that produces `Фамилия И. О.`, but it is renderer-only. Fiscal operator in main is currently raw `cashierAuth.state().employee?.name || database?.currentShift()?.cashierName`. `pos/src/main/providers/atol-json.ts` only trims the string before assigning `operator.name`; Driver 10 paths use that current operator for shift/check operations. DEV-091 preserved operator identity through recovery but did not normalize the format or prove the Cyrillic encoding path.

## Architecture decisions

1. Move/extract a pure person short-name formatter to a shared module usable by renderer and main. It must preserve Unicode code points from the canonical employee name and only transform whitespace/name parts into `Фамилия И. О.`. Do not transliterate, replace `е` with `ё`, guess spelling, or sanitize Cyrillic into Latin.
2. One canonical fiscal-operator function is applied before every ATOL fiscal operation that accepts operator identity: sale, return, open fiscal shift, close fiscal shift and recovery paths that re-use stored operator. Do not create divergent per-operation formatting.
3. Encoding is a separate transport concern. Read `pos/DEV-151-ATOL-DRIVER.md` before changing Driver 10 integration. Audit the exact path `main TS -> bridge process stdio -> System.Text.Json -> COM Driver 10 processJson -> bridge stdout`. Explicitly set/retain UTF-8 where stdio boundaries need it, and avoid double encoding. `operator.name` entering JSON and returned diagnostic text must remain Unicode.
4. Do not change fiscal idempotency/recovery semantics. A transport/encoding failure after an unknown fiscal side effect must not trigger a blind reprint/repeat.

## Stages

1. Shared formatter + call sites: existing renderer `person-name.ts`, a shared pure formatter module under `pos/src/shared`, `pos/src/main/index.ts` currentOperator path and focused tests. Update renderer imports to avoid duplicate implementations.
2. ATOL transport: first read `pos/DEV-151-ATOL-DRIVER.md`; then inspect/change only `pos/src/main/providers/atol-json.ts`, `pos/src/main/providers/atol-driver.ts`, `pos/src/main/providers/atol-driver-bridge.ts`, `pos/native/atol-bridge/Program.cs` and narrow tests/diagnostics needed to guarantee Unicode transport.

## Acceptance

Canonical `Иванов Иван Иванович` reaches fiscal JSON as `Иванов И. И.`; already-canonical Cyrillic including `ё` is preserved exactly. sale/return/openShift/closeShift all use the same formatter. Unit/integration bridge test with Cyrillic round-trip passes without mojibake. No transliteration or arbitrary character substitution exists. Hardware acceptance on a real ATOL KKT is a separate post-CI step and must verify printed operator text.

No compile-time ATOL DLL, no provider redesign, no blind fiscal retry, and no PR/merge/deploy during stages.