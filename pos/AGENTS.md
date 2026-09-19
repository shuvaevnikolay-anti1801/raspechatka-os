# Windows POS — coding agent instructions

Applies to `pos/**`. Also follow root `AGENTS.md`.

## Boundaries

- Keep Electron boundaries explicit:
  - `src/main`: OS access, SQLite, IPC handlers, providers, hardware/process management.
  - `src/preload`: narrow typed bridge only.
  - `src/renderer`: UI; no direct filesystem, process, COM/native SDK or hardware access.
  - `src/shared`: transport/domain types shared across renderer/main.
- Hardware stays behind provider contracts. Do not let sale UI call ATOL/INPAS/Windows APIs directly.
- Preserve offline-first behavior. Server unavailability must not break local workflows that do not require the server.
- Do not grow unrelated workflows in one root component; keep Sale/Receipts/Orders/Shift/Work/Settings focused.

## Transaction safety

`PosTransactionEngine`, `TransactionJournal`, provider contracts and recovery states are correctness boundaries.

- External payment/fiscal timeout, crash or lost response may mean **unknown**.
- Never auto-repeat a payment/fiscal action while its result is unknown.
- Persist intent/evidence before dangerous external actions when recovery depends on it.
- Reconcile first; repeat only when non-execution is established.
- Keep payment/fiscal operations serialized where the device/API is not safe for concurrent commands.
- Do not weaken blocking of unresolved dangerous states to improve UX.
- A fiscal-copy/reprint must not create a new fiscal sale/return.

## Shifts

- Employee work shift and fiscal KKT shift are different facts.
- Preserve `ShiftCoordinator` recovery semantics: local work shift may open/close while fiscal transition remains pending.
- Expired/unknown fiscal state may block fiscal sales without rewriting local employee-shift history.

## ATOL tasks

For any direct ATOL Driver 10 work, **read `pos/DEV-151-ATOL-DRIVER.md` before planning or editing**.

Key invariants:
- Target default path: POS → `FiscalProvider` → `AtolDriverFiscalProvider` → bridge → installed official ATOL Driver 10 → KKT.
- Do not hard-code ATOL 1F/model 93; identify the physical configured KKT by serial number and let Driver determine model.
- Keep existing ATOL Web Requests implementation as hidden legacy fallback until a separate removal task.
- No blind retry after an uncertain fiscal result.
- Do not bundle a private/frozen Driver 10 into POS without an explicit separate decision.
- Ordinary user UX must not require Web URL/login/password, COM/DLL knowledge or Driver constants.

## Payment terminal

For DEV-152 direct INPAS/PAX work, **read pos/DEV-152-INPAS-PAX.md before planning or editing**.

INPAS/PAX has the same unknown-outcome rule: exit/process failure is not proof that a bank operation did not occur. Preserve reconciliation before retry. Do not treat operation 4 as a generic refund; DEV-152 separates Refund 29 from Void 4. Do not bundle bank-owned DualConnector binaries into POS.

## Tests and commands

From `pos/`:
```bash
npm ci
npm run typecheck
npm test
npm run build
```

Use targeted Vitest files while iterating; run the full POS suite/typecheck/build before PR completion. Run `npm run package:win` when packaging/installer files change or the task requires installer proof.

Hardware acceptance is separate from automated tests. Report explicitly whether real KKT/PAX hardware was tested.

## Shared hotspots

Make small, additive changes in:
- `src/main/index.ts`
- `src/main/hardware-ipc.ts`
- `src/preload/index.ts`
- `src/shared/contracts.ts`
- large settings/root renderer components

Prefer extraction behind existing contracts over broad rewrites.
