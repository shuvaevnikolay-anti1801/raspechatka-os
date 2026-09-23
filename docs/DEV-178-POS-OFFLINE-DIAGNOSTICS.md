# DEV-178 — POS Offline Reliability + Diagnostics

Base: `version-16` @ `91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Plans: PLAN-057, PLAN-062, PLAN-067.

## Verified current state

`pos/src/main/sync.ts` already uploads events individually, marks only accepted events synced, keeps rejected events pending, uses `Promise.allSettled`, and syncs catalog independently. Server `raspechatka/api/pos_v2.py` already returns per-event `accepted/errors` and isolates events with savepoint/rollback. Local outbox currently stores id/event_type/payload/created_at/synced_at only, so repeated failures have no durable attempt/error/backoff state. Settings/diagnostics mix operational and technical text, and user-facing errors can expose transport/internal details.

## Architecture decisions

1. Extend outbox schema additively with durable retry metadata: `attempt_count`, `last_attempt_at`, concise normalized `last_error`, `next_attempt_at`, and quarantine/dead-letter state. Existing rows migrate as pending with zero attempts. Accepted-only semantics stay unchanged. Backoff is bounded exponential with jitter or deterministic bounded schedule suitable for tests; no tight retry loop after persistent rejection.
2. Distinguish channels: OS/backend sync, local KKT availability, acquiring/payment terminal, remote payment. OFD status is shown only if the active fiscal provider exposes a reliable signal; do not infer OFD health from generic internet access. KKT/FN acceptance remains authoritative: OFD/backend outage after successful fiscalization must never cause refiscalization.
3. Payment-method availability is current point configuration AND provider/channel health. This changes what can be initiated, not recovery rules for an already-started unknown payment. Unknown external-effect operations remain in the existing protected recovery area and are never generic queue entries.
4. Queue UI/actions cover ordinary server-sync outbox events only. Display type/purpose, created time, status, last attempt and concise reason. Admin Retry/Delete may exist only for event types explicitly classified safe/idempotent. No generic Retry/Delete for payment, fiscal or unknown external effects. Deleting a safe queue event is an explicit administrative discard with confirmation/audit; it must never masquerade as successful sync.
5. Settings is compact and task-oriented. Keep meaningful provider/device/recovery controls. Diagnostics shows app/config version, channel/provider health, OS, last successful sync, queue counts and last normalized errors. Technical logs stay separate.
6. User-facing toasts/messages state the action and result only. Raw file paths, event IDs/outbox IDs, stack traces, HTTP/transport payloads and low-level exceptions stay in internal logs/diagnostics. Partial failure must not emit a global success message.

## Stages

1. Outbox reliability: `pos/src/main/database.ts`, `pos/src/main/sync.ts`, narrow contracts/tests. Add schema migration, retry scheduling and quarantine metadata while preserving accepted-only behavior.
2. Health model: `pos/src/shared/contracts.ts`, provider/main health plumbing, `pos/src/main/frappe.ts`/sync status and focused tests. Build explicit health states; no speculative OFD.
3. Safe queue operations: database/main/preload/IPC/settings contract for list/retry/discard of allow-listed ordinary idempotent server events only; tests proving payment/fiscal/unknown records cannot be manipulated through this API.
4. Settings/diagnostics UI: `pos/src/renderer/src/SettingsHub.tsx`, diagnostics/settings components and CSS/tests. Compact copy, channel statuses, queue table/actions, app/config/OS/last-sync/error summary; preserve real ATOL/Aquarium/INPAS/printer/recovery controls.
5. Message normalization: renderer action handlers plus a small shared user-message mapper if needed. Keep detailed error logging in main. Audit common sale/order/warehouse/sync/settings paths for raw technical leakage and false success.

## Safety invariants

Stable event IDs are retained across retries. A rejected or transport-failed event is not marked synced. An accepted event is not resent. Retry/delete APIs are deny-by-default by event type. Unknown payment/fiscal outcomes retain their dedicated reconciliation flows. No diagnostics action may repeat an external money/fiscal side effect.

## Acceptance

Persistent failure increases durable attempt metadata and respects backoff across restart. Accepted events leave queue once. Settings shows accurate separate health channels and pending/quarantined counts. Safe ordinary events can be retried/discarded only when allow-listed; money/fiscal unknowns cannot. User toasts are concise and non-technical while diagnostics/logs retain enough detail for support. Offline KKT/backend/OFD distinctions never trigger duplicate payment or receipt.

No PR/merge/deploy/full Windows package during intermediate stages; one final gate after architect review.