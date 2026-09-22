# DEV-163 — Windows POS: cashier access and unified settings

Branch: `codex/dev-163-pos-access-settings`  
Base: `version-16@4030e47f120efe87d872642c2d2f69dbd64d2e1e`  
Plans: PLAN-051, PLAN-052, PLAN-053, PLAN-054, PLAN-055.

## Goal

Unify all cashier/admin PIN flows, make cashier hand-off explicit and safe, route every Settings entry point through the one full `SettingsHub`, and allow initial/admin POS pairing without requiring a cashier session.

Do not change sale/payment/fiscal/shift business rules. In particular, an open work shift still prevents changing the cashier.

## Current facts from stable

- `AppV2.tsx` owns `PinInput` and `CashierLogin`.
- Locked cashier flow only offers PIN for the current employee; “Забыли PIN?” is hidden while locked.
- `CashierAuthSession.logout()` already blocks logout while `database.currentShift()` exists and allows it when there is no shift. Preserve this invariant.
- The actual full settings UI is `SettingsHub.tsx`.
- `SettingsHub` intercepts `.main-nav>button` index 5 or `.settings-open-trigger`, but the current POS header uses `.pos-header-nav`. Therefore the internal “Настройки” nav is not intercepted and `AppV2` renders the obsolete inline `Settings(...)` page.
- `pos:save-connection` does not require cashier auth, but `SettingsHub.saveConnection()` immediately calls ordinary `syncNow()`, whose IPC handler calls `assertCashierAccess()`. This is the source of “first login as cashier” during admin setup.
- Current stable source contains no “POS Ready” / “Подключение POS Ready” UI string. Treat PLAN-055 as a regression requirement: do not remove unrelated runtime compatibility state without evidence.

## Architecture

### Shared PIN presentation

Create a small renderer-only shared PIN component/layout used by cashier login/unlock/reset and admin settings gate. Keep one real input with four visual slots, digits-only, max length 4, normal form submit/Enter semantics.

All PIN screens:
- center the PIN block in the available main area;
- make slots visibly larger/touch-friendly;
- keep “Настройки кассы” bottom-left;
- keep “Забыли PIN?” bottom-right where cashier PIN recovery applies;
- use one layout/style, not copies.

### Cashier lock/switch

When locked:
- if no work shift is open, show an explicit “Сменить кассира” path. It must call the existing safe logout contract and return to employee selection.
- if a work shift is open, do not allow changing employee. Show an explanation that the current cashier must unlock and close the shift first.
- “Забыли PIN?” must work for the locked employee and reset that employee’s PIN through the existing admin-code flow.
- never bypass `CashierAuthSession.allowed()`, `logout()`, shift ownership or PIN verification.

### One Settings page

Both:
1. pre-login/locked `settings-open-trigger`;
2. authenticated header “Настройки”

must open the same `SettingsHub` admin gate, then the same full settings page.

Retire the obsolete inline `AppV2.Settings` screen after no code path uses it. Do not maintain two settings implementations.

The Settings admin PIN gate should use the shared 4-slot PIN component and the same centered PIN visual language. Existing admin code remains 0000 and verification remains in main process.

### Admin configuration sync

Separate **configuration/bootstrap refresh** from ordinary cashier document sync.

Admin settings must be able to:
- save server/device/token;
- validate/load point/workplace/employees/catalog/settings needed to finish setup;

without an authenticated cashier.

Do not use this admin path to flush arbitrary business outbox events without a cashier. Ordinary `syncNow` remains the full cashier-authenticated synchronization path.

Extract/reuse a narrow bootstrap refresh helper from `sync.ts` if needed and expose a dedicated IPC/preload API such as `syncConfiguration`. Preserve current connection identity protection: changing point/device while a shift is open remains blocked.

### Obsolete POS Ready

No current stable source renders “POS Ready”. Add a focused regression assertion that the full SettingsHub/ATOL section does not contain the obsolete control/copy. Do not delete backend fields or old compatibility code merely to satisfy the historical plan unless a direct runtime dependency is proven.

## Stages

### DEV-163 (1) — PIN UX and cashier hand-off

Primary files:
- `pos/src/renderer/src/AppV2.tsx` — `CashierLogin` / PIN flow only;
- new shared renderer PIN component/style allowed;
- `pos/src/renderer/src/pos-v2.css` or a focused PIN stylesheet;
- `pos/src/main/cashier-auth.ts` read first; change only for a proven narrow contract defect;
- focused renderer/auth tests.

Deliver:
- centered/larger shared PIN UI;
- locked “Забыли PIN?”;
- “Сменить кассира” only when no shift;
- open-shift block/explanation;
- footer Settings left / Forgot PIN right;
- no auth-rule weakening.

### DEV-163 (2) — one full SettingsHub

Primary files:
- `SettingsHub.tsx`, `settings-hub.css`;
- shared PIN component from (1);
- `AppV2.tsx` header settings route + obsolete inline Settings removal;
- focused renderer tests.

Deliver:
- both entry points open the same admin gate/full SettingsHub;
- no legacy restricted Settings screen;
- centered 4-slot admin PIN;
- diagnostics/hardware/full settings remain available.

### DEV-163 (3) — admin pairing without cashier

Primary files:
- `pos/src/main/sync.ts`;
- `pos/src/main/ipc.ts`;
- `pos/src/preload/index.ts`;
- `pos/src/shared/contracts.ts` / renderer global typing only if additive API typing is required;
- `SettingsHub.tsx`;
- focused sync/IPC tests.

Deliver:
- dedicated admin bootstrap/configuration refresh that does not require cashier;
- no business outbox flush through unauthenticated admin setup;
- ordinary cashier `syncNow` unchanged for document queue;
- open-shift identity-change guard preserved;
- regression that obsolete “POS Ready” is absent.

## Acceptance

- Every PIN entry feels like one system and is large/centered.
- With a closed shift: lock → switch cashier → employee selection is obvious.
- With an open shift: switching cashier is blocked and explained.
- Forgot-PIN is available in locked cashier flow.
- Pre-login and authenticated Settings use one admin PIN gate and the same full SettingsHub.
- Admin can connect a new POS to Raspechatka OS before any cashier logs in.
- Admin setup does not push cashier-owned business events without a cashier.
- ATOL settings no longer expose historical POS Ready UI.
- No payment/fiscal/transaction semantics changed.
