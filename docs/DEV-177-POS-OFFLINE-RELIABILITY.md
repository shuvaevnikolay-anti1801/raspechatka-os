# DEV-177 — offline-first outbox, health and operator-safe diagnostics

Plans: PLAN-057, PLAN-062, PLAN-067.
Initial baseline: `version-16@91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Branch: `codex/dev-177-pos-offline-reliability`.
Dependency: implement LAST, after DEV-170…176 event/contracts are merged; architect updates branch to then-current stable before coding.
Risk: durable business events + external payment/fiscal outcomes.

Read root/POS/backend AGENTS, `pos/DEV-151-ATOL-DRIVER.md`, DEV-168 reliability spec and current provider/recovery contracts before stages.

## Official fiscal premise
For ordinary online KKT mode, temporary loss of Internet/OFD connectivity is not the same as inability to fiscalize: the KKT/FN forms the fiscal document at payment time, stores unsent data and transmits it after connectivity returns; prolonged non-transmission can eventually block new fiscal documents. Therefore POS must never invent an application-level `fiscalize later` queue merely because OFD/Internet is unavailable. If the KKT/FN itself cannot prove fiscal execution, existing UNKNOWN/reconciliation rules apply.

## Current facts
- Local outbox persists id/type/payload/created/sent only. Sync has batch partial acceptance and global retry delay, but no durable per-event attempt/error/problem state.
- POS v2 server uses per-event savepoints and accepted/errors protocol; supported business events already have several idempotency keys from DEV-168.
- Settings currently combines OS/KKT/acquiring/printer status and shows unresolved external operations separately, but there is no operator-facing document queue or OFD-specific channel.
- Some UI/manual-sync messages expose technical event IDs/types/errors; raw details should live only in diagnostics.

## Outbox v2 contract
1. Every durable event keeps a stable immutable ID, event type, created timestamp, trusted point/cashier context where required, payload, attempt count, last attempt time, next attempt time, status and sanitized last error. Version/migrate the SQLite schema additively.
2. Delivery remains at-least-once. Only server-accepted IDs become sent. Network/temporary errors back off durably; permanent validation/unsupported events enter explicit `problem` state rather than hot-looping forever.
3. Inventory every server event type used after DEV-170…176 and prove an idempotency/deduplication boundary before enabling manual retry. Durable stock/money/fiscal effects require transactional uniqueness or equivalent owner-domain protection.
4. Manual Retry/Cancel is allowlisted by event class/state. Never offer generic Retry/Delete for payment/fiscal UNKNOWN operations, already-started external side effects, or events whose cancellation would erase a committed business fact.

## Stage 2 — current server event inventory and manual-action gate

The v2 dispatcher currently supports these 13 event types. The immutable outbox ID is
transport identity; the owner-domain key below is the canonical deduplication identity.
All existing documents must belong to the authenticated connection's point. A unique
field rejects a concurrent insert that wins the race after an initial lookup; the losing
attempt remains unaccepted and can reconcile by repeating the same key.

| Event | Canonical key and database constraint | Owner guard / effect |
| --- | --- | --- |
| `shift.opened` | payload `id` → Sales Shift `external_id` unique | Point and cashier on existing shift; OPEN_SHIFT Cashier Action `<id>:open` unique. |
| `shift.closed` | same Sales Shift `external_id` unique | Existing shift point/cashier; CLOSE_SHIFT Cashier Action `<id>:close` unique. |
| `sale.completed` | payload `id` → Sales Receipt `external_id` unique | Shift point and submitted receipt point; review Cashier Action `<id>:reviews` unique. Fiscal operation already completed locally before enqueue. |
| `sale.returned` | payload `id` → Sales Receipt `external_id` unique | Shift point and submitted receipt point; local fiscal refund already completed. |
| `cash.deposited` | payload `id` → Cash Movement `external_id` unique | Shift point and submitted movement point. |
| `cash.withdrawn` | payload `id` → Cash Movement `external_id` unique | Same; cleaner payout additionally has unique `cleaning_payout_id`, locks point, verifies submitted withdrawal and exact cycle/visits before marking linked visits paid. |
| `cash.counted` | outbox `id` → Cashier Action `external_id` unique | Shift point/cashier; count and action share event savepoint. |
| `stock.write_off.requested` | outbox `id` → Stock Write Off `external_id` unique | Submitted document point, server warehouse/balance and cashier; insert precedes stock effect. |
| `point.supply.requested` | outbox `id` → Point Supply Request `source_pos_event` unique | Document point, canonical item/warehouse and trusted employee. |
| `stock.receipt.requested` | outbox `id` → Stock Receipt `external_id` unique | Submitted document point; Purchase Order row `FOR UPDATE`, then recheck key and server-owned remaining quantities before stock effect. |
| `cleaner.visit.recorded` | outbox `id` → Cleaner Visit `source_pos_event` unique | Point row `FOR UPDATE`, existing visit point, one visit per point-local date. |
| `order.created` | outbox `id` → POS Order `source_pos_event` unique | Existing order point; source receipt resolved only at authenticated point. |
| `order.updated` | outbox `id` → POS Order `last_pos_update_event` unique for the latest timestamped event | Point and order row `FOR UPDATE`; `last_pos_update_at` rejects stale replays. Legacy updates without `updatedAt` retain compatibility but have no proven event history. |

**Future generic actions (no action endpoint or UI in this stage):** A retry may only
reuse the same immutable event and payload. Candidate allowlist is `order.created`,
timestamped `order.updated`, `stock.write_off.requested`,
`stock.receipt.requested`, `point.supply.requested` and
`cleaner.visit.recorded`, while status is `pending` and no unresolved
external effect exists. `problem` requires diagnosis/correction first. Money,
cash, shift, sale/return and cleaner payout events are excluded from generic
manual retry; their local completed effects or external evidence require a
specific reconciliation flow. No generic Cancel/Delete is allowlisted: dropping
any currently queued event could hide an already committed local fact, and a
request may already have succeeded despite a lost response. Payment/fiscal
UNKNOWN remains exclusively in transaction recovery.

## Health model
Separate at least: Raspechatka OS/backend, KKT/device+FN, KKT↔OFD delivery state when Driver exposes reliable evidence, acquiring terminal, remote-link payment capability, printer/other integrations. A backend outage must not block local workflows that are designed to work offline. Acquiring outage disables only its payment methods. KKT/FN unsafe/unavailable state blocks fiscal sale as today. OFD/Internet-only outage does not defer the fiscal action to POS.

## Stage 3 — independent health channels

`DeviceStatuses` preserves the existing `os`, `fiscal`, `payment`,
`printer` and `shift` fields and adds `ofd`, `remotePayment` and
`paymentMethods`. OS status comes from the last bootstrap/sync result;
fiscal readiness comes from the local KKT and positive FN presence evidence;
terminal health comes from the selected INPAS provider; printer health is
local. A failure to read one provider does not erase the other channels.

The present ATOL Driver bridge status contains no verified OFD queue/delivery
evidence. Direct Driver reports `ofd: unknown`; providers without such a
channel report `not_available`. Neither OS connectivity nor terminal
connectivity is used as OFD evidence. The OFD field is never a fiscal gate:
a ready KKT/FN executes fiscalization now and the FN owns any OFD backlog.
A missing or unsafe FN, expired fiscal shift, or unavailable KKT remains
a blocker. UNKNOWN payment/fiscal results stay in their existing recovery path.

Cash follows point rules offline; card and terminal QR require INPAS readiness;
remote payment follows point configuration and backend availability, with its
existing explicit cashier confirmation. An INPAS outage does not disable cash
or remote payment. No generic health state triggers payment/fiscal retries.

## Settings/diagnostics/notifications
- Simplify Settings copy without removing proven necessary connection/provider controls.
- Add a separate sync queue view: human event label, time, status, attempts and human-safe error; safe Retry/Cancel only when contract permits.
- Keep payment/fiscal unresolved operations in recovery, not in generic queue actions.
- Diagnostics includes versions, current provider/device health, last successful sync, queue counts/problem events and recent technical errors. Raw paths, event IDs, transport codes and exception details stay here/logs.
- Centralize user-facing notification mapping so toasts/alerts state only action/result/recovery guidance and never dump raw exception/path/event/transport text. Partial result must not be announced as full success.

## Stages
1. Versioned outbox v2 schema/state/backoff/problem transitions + focused migration tests.
2. Server idempotency inventory/hardening for all active business event classes + negative/replay tests.
3. Split provider/device/OFD/backend/payment health contracts and gating semantics.
4. SettingsHub sync queue + health + diagnostics surfaces with allowlisted actions.
5. Central user-notification sanitizer/result mapping across runtime flows.
6. Integrated offline/restart/problem/recovery sweep after all previous DEV contracts are present.

## Acceptance
Scenarios: backend down/recover; one permanently invalid event while later valid events sync; restart during backoff; duplicate delivery; safe cancel; acquiring down; remote method down; KKT disconnected; KKT working while OFD/Internet down; payment/fiscal UNKNOWN with no generic retry; sanitized operator notification with raw diagnostic retained. Full CI/package once at final architect review; hardware acceptance separately verifies KKT/OFD observations where Driver exposes them.