# DEV-171 — POS cashier auth/PIN UX

Plan: PLAN-059.
Baseline: `version-16@91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Branch: `codex/dev-171-pos-cashier-auth-ux`.

## User outcome
All cashier PIN scenarios look and behave like one four-digit PIN system, while cashier selection and footer actions become clearer without changing authentication rules.

## Current facts
- `PinEntry.tsx` already has one real password/numeric input plus four visual slots and is reused by cashier/admin flows.
- DEV-163/166 established lock/switch/reset semantics and success/error severity; DEV-169 established POS design tokens/primitives.
- Settings admin gate already uses the shared PinInput. This DEV is presentation/focus/keyboard only.

## Fixed contracts
1. Keep exactly one real input and four visual slots; digits-only, maxLength=4, native form/Enter flow, focus and Backspace semantics unchanged.
2. Apply one visual primitive to employee selection PIN, ordinary login/unlock, forgot/reset, new PIN/repeat PIN and admin gate. Do not fork another PIN implementation.
3. Cashier cards in idle/selectable state receive the requested thin green border without implying authentication success.
4. `Настройки кассы` and `Забыли PIN?` footer actions gain horizontal padding/touch area but retain current callbacks and visibility rules.
5. Do not change PIN hashing, session state, employee-point authorization, open-shift cashier ownership, reset permissions or admin verification IPC.

## Stages
1. Shared PIN primitive visual/focus/keyboard contract across all mounted flows.
2. Cashier cards and footer action spacing.
3. Focused auth UX/adaptive regression sweep.

## Acceptance
Tests cover one-input/four-slots, digits-only, focus/Backspace/Enter, reset/new/repeat flows, admin gate reuse, cashier card selection and unchanged auth callbacks. No backend/auth changes and no full CI/build/package until final architect review.