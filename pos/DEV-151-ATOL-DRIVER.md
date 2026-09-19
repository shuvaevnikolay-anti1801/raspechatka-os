# DEV-151 — direct Windows POS integration with ATOL Driver 10

This document is the implementation brief for DEV-151. Read it for ATOL direct-driver tasks instead of rediscovering the whole repository or re-reading the Google backlog.

## User outcome

Installation/configuration should feel like choosing a printer:

1. Official ATOL Driver 10 x64 is installed on Windows.
2. The physical KKT is connected and communication works in ATOL's own Driver Test utility.
3. In Raspechatka POS → Settings → KKT ATOL, the user sees discovered ATOL devices.
4. The user selects the correct KKT (model + serial number) and runs a connection check.
5. From then on POS uses that configured physical KKT for fiscal shift, sale, return and reprint.

Ordinary users must not configure Web Requests URL/login/password, COM/OLE, DLLs, VID/PID or numeric model constants.

## Current code reality (version-16 baseline)

- `src/main/index.ts` currently creates `AtolWebFiscalProvider` for real fiscal mode.
- `providers/atol-web.ts` is a real Web Requests implementation: settings, shift state/open/close, sale, return, operation-status polling by UUID, reprint, fiscal JSON construction and operator.
- `atol-web-manager.ts` manages the local ATOL Web Requests process/auth/device configuration.
- `providers/atol-driver.ts` and `providers/atol-driver-bridge.ts` exist but are placeholders.
- `hardware-ipc.ts` is currently Web-specific for ATOL settings/device configuration.
- `TransactionEngine` already treats an unconfirmed fiscal result as dangerous/unknown and blocks blind continuation.
- `TransactionJournal` persists operations/payment/fiscal attempts, but direct-driver recovery will need more KKT evidence.
- `ShiftCoordinator` intentionally separates employee work shift from fiscal KKT shift and has pending transition recovery.
- Existing Web Requests code must stay as hidden legacy fallback during DEV-151.
- `EQUIPMENT.md` historically lagged runtime behavior; verify code before assumptions.

## Target architecture

```text
Renderer settings/sale UI
        ↓
Electron main
        ↓
FiscalProvider
        ↓
AtolDriverFiscalProvider
        ↓
AtolDriverBridge (TypeScript)
        ↓ JSON-lines stdin/stdout
Raspechatka.AtolBridge.exe (.NET x64)
        ↓
official installed ATOL Driver 10
        ↓
USB / later COM or TCP
        ↓
ATOL KKT
```

Use a small separate Windows helper rather than making Electron depend directly on a third-party Node COM/FFI addon. The helper may use the official Driver 10 .NET wrapper or COM/OLE internally; Electron must not care.

Do not start a new localhost HTTP service.

## Model/device identity

- Do not hard-code ATOL 1F or model 93.
- Use Driver automatic model detection (the current SDK's AUTO model equivalent).
- After connection query model name, serial number, firmware/unit version, connection type and Driver version.
- Model is display metadata; configured physical-device identity is primarily `serialNumber`.
- On startup apply saved Driver settings, connect, then verify the actual serial matches the configured serial.
- If configured KKT is missing and another ATOL is found, never switch automatically.

Initial supported production assumption: one Windows POS workstation = one USB KKT. Keep discovery contracts as arrays so multi-device/COM/TCP can be added later. Do not guess when identical USB devices cannot be distinguished safely.

## Bridge protocol

Suggested native project:
```text
pos/native/atol-bridge/
  Raspechatka.AtolBridge.csproj
  Program.cs
  Protocol.cs
  AtolSession.cs
  AtolDiscovery.cs
  AtolStatus.cs
  AtolJsonExecutor.cs
  AtolRecovery.cs
```

Launch with `child_process.spawn`, `shell:false`, `windowsHide:true`.

Use line-delimited JSON:
- stdout: protocol responses only;
- stderr: technical logs;
- include `protocolVersion: 1`.

Minimum commands:
- `driverInfo`
- `discover`
- `connect`
- `disconnect`
- `status`
- `executeJson`
- `lastFiscalDocument` / recovery probe
- `reprintLastReceipt`
- optional admin `showProperties`
- `shutdown`

All Driver calls for one KKT must pass through one serialized queue / semaphore. Health polling may not race a fiscal operation.

## TypeScript bridge/contracts

Evolve current types toward:

```ts
type AtolDriverInfo = {
  installed: boolean
  version?: string
  architecture?: 'x64' | 'x86'
  error?: string
}

type AtolDriverDevice = {
  id: string                 // e.g. atol:<serialNumber>
  serialNumber: string
  modelName: string
  firmwareVersion?: string
  connection: 'usb' | 'com' | 'tcp'
  settingsJson: string
}
```

Bridge operations should cover Driver info, discovery, connect/disconnect, status, executing fiscal JSON, recovery probe and reprint.

## Settings migration

Move from Web-only settings to a versioned shape conceptually like:

```ts
{
  version: 2,
  enabled: boolean,
  adapter: 'driver' | 'web',
  taxationType: string,
  taxType: string,
  direct?: {
    selectedDevice?: {
      serialNumber: string,
      modelName: string,
      connection: 'usb' | 'com' | 'tcp',
      settingsJson: string
    }
  },
  web?: { baseUrl: string }
}
```

- New installations default to `driver`.
- Existing working Web installations must not break on upgrade; preserve a `web` adapter path.
- Direct mode must not require URL/username/password.
- Save the Driver settings returned by the official SDK plus stable device identity.

## Provider factory

Remove transport choice from `index.ts` by introducing a small factory:
- training → `MockFiscalProvider`
- adapter `web` → current `AtolWebFiscalProvider`
- adapter `driver` → `AtolDriverFiscalProvider`

Do not rewrite `TransactionEngine` or `ShiftCoordinator` to know about ATOL transport.

## Share fiscal JSON construction

The Web provider already contains working receipt construction:
- allocation/rounding;
- sale vs sellReturn;
- cash vs electronic payments;
- product/service payment object;
- taxation/tax mapping;
- operator;
- payment-total validation.

Extract this into a transport-neutral ATOL JSON builder and use it from Web and Direct paths. Prefer the official Driver 10 JSON-processing entry point (`processJson` or the installed SDK's equivalent) when available instead of duplicating the receipt through many low-level calls.

Preserve current tax mapping, including VAT 22% support in the POS settings/contracts.

## Health/status

Direct health must distinguish useful states rather than returning one generic connection error:
- Driver missing/incompatible architecture;
- no configured device;
- configured serial missing / another serial present;
- connection/USB failure or device busy;
- no paper/open cover/printer failure;
- FN missing/failure/block;
- fiscal shift closed/opened/expired;
- ready.

Keep raw Driver error code/details in diagnostics while showing a clear Russian operator message.

## Fiscal transaction safety — critical

A direct Driver call does not have the current Web Requests HTTP UUID/status resource. Therefore an exception/timeout after starting a fiscal action does **not** prove the receipt failed.

Never:
```text
sell → timeout → send sell again
```

Instead:
1. persist a fiscal attempt and KKT evidence before the external action;
2. perform the action;
3. if result is confirmed, mark fiscalized;
4. if communication/crash leaves the result uncertain, keep `fiscal_status_unknown`;
5. recover/reconcile before any repeat.

Suggested extra evidence for `fiscal_attempts`:
- `kkt_serial_number`
- `shift_number_before`
- `fiscal_document_number_before`
- `kkt_datetime_before`
- `request_hash`
- `fiscal_document_number_after`
- `fiscal_sign`
- `shift_number_after`

Recovery should reconnect to the same serial, inspect KKT/document state and query the last fiscal document/FN data available from the current Driver SDK. Compare with the pre-operation snapshot (document progression, type, amount, shift, time and other reliable fields):
- proven matching fiscal document → `fiscalized`;
- proven no fiscal document → `not_found`;
- cannot prove either → `unknown`.

Do not confuse internal receipt/document counters with the FN fiscal document number.

Unknown result continues to block dangerous new operations through existing TransactionEngine semantics.

## Shifts and reprint

Keep existing `ShiftCoordinator` semantics. Implement Driver provider status/open/close using current operator and map closed/opened/expired.

Reprint/copy must print an existing fiscal document/copy; it must never generate a new sale/return.

## UI / IPC

Normal Settings UX:
- Driver installed/version;
- discovered device dropdown (model + serial + connection);
- current health;
- fiscal shift state;
- taxation system and VAT;
- Refresh devices;
- Connect/Save;
- Test connection.

No Web URL/login/password or COM/native internals in normal mode.

Advanced admin diagnostics may later expose the official Driver properties dialog and save returned Driver settings.

IPC/preload should expose narrow operations such as:
- get Driver info;
- discover devices;
- select/save device;
- test selected device;
- get/save ATOL settings.

Keep legacy Web handlers separately rather than mixing their configuration into direct mode.

Do not allow device reassignment while a fiscal operation is in progress/unknown; preferably not during an open shift. Future health may compare KKT registration INN with the point's Business Entity.

## Driver installation/update policy

- POS expects the official ATOL Driver 10 installed on Windows.
- Do not ship a frozen private copy of Driver 10/fptr10 with POS as part of DEV-151.
- Standardize first on Windows x64 + POS x64 + helper x64 + Driver x64.
- Record/show Driver version, but avoid exact-version branching when capability checks are sufficient.
- After Driver update, reapply saved settings and verify the configured serial.

## Diagnostics

Useful event families:
- `atol.driver.detected/missing`
- `atol.device.discovered/selected/connected/connection_lost`
- `atol.fiscal.started/completed/unknown`
- `atol.recovery.started/completed/unresolved`
- `atol.shift.opened/closed`

Include technical Driver/model/serial/firmware/shift/fiscal-document/error details without logging unnecessary customer personal data.

## Suggested implementation slices

Do not ask one Codex turn to implement the entire DEV-151.

### Slice 1 — native bridge foundation
Scope:
- native .NET helper skeleton;
- protocol + process lifecycle;
- Driver info/discovery/connect/status;
- TypeScript bridge client;
- fake/contract tests.

Do **not** implement sale/return/UI/recovery yet.

Done: helper builds, TS bridge tests pass, existing POS typecheck/tests/build remain green.

### Slice 2 — settings + discovery UX
Scope:
- settings V2/migration;
- provider factory;
- IPC/preload discovery/select/test;
- Settings UI.

Done: configured KKT persists by serial and Web legacy remains available.

### Slice 3 — direct fiscal provider
Scope:
- shared ATOL JSON builder;
- direct shift/sale/return/reprint;
- provider tests with fake bridge.

Done: automated tests pass without hardware; no change to unknown-outcome safety.

### Slice 4 — direct recovery
Scope:
- journal evidence migration;
- KKT snapshot/recovery probe;
- fiscalized/not_found/unknown reconciliation;
- crash/timeout tests.

Done: no blind retry path exists.

### Slice 5 — packaging + real hardware acceptance
Scope:
- Windows CI/.NET publish;
- Electron extraResources;
- diagnostics/documentation;
- real KKT smoke/acceptance.

Hardware acceptance must include sale/return/shifts plus USB loss/restart during a dangerous fiscal boundary and prove no duplicate fiscal receipt.

## Required source files before implementation

Read the current versions of only the files relevant to the slice, normally from this list:
- `src/main/index.ts`
- `src/main/providers/contracts.ts`
- `src/main/providers/atol-web.ts`
- `src/main/atol-web-manager.ts`
- `src/main/providers/atol-driver.ts`
- `src/main/providers/atol-driver-bridge.ts`
- `src/main/transaction-engine.ts`
- `src/main/transaction-journal.ts`
- `src/main/shift-coordinator.ts`
- `src/main/hardware-ipc.ts`
- `src/preload/index.ts`
- `src/renderer/src/SettingsHub.tsx`
- `src/renderer/src/AtolSetupAssistant.tsx`
- `src/shared/contracts.ts`
- `package.json`
- `../.github/workflows/pos-windows.yml`

Do not read every file for every slice; use the slice scope.

## Driver references

Use the official installed Driver SDK as the authority for exact API signatures/constants.

Reference entry points:
- https://www.atol.ru/company/service-support/dkkt10-platforma5/
- https://integration.atol.ru/
- https://pbardov.github.io/fptr10-doc/ (useful secondary published copy; do not copy old numeric constants blindly)

## Definition of done for whole DEV-151

On Windows x64 with official ATOL Driver 10, Raspechatka POS discovers a supported ATOL KKT, lets an admin select it by model/serial, reconnects the same serial after restart/Driver update, and performs health, fiscal shifts, sale, return, reprint and safe unknown-result recovery without ATOL Web Requests.

ATOL Web Requests remains hidden legacy fallback. No timeout/crash/USB loss may trigger automatic duplicate fiscalization.
