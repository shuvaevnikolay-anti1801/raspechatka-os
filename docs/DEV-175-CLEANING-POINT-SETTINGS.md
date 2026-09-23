# DEV-175 — Cleaning: point settings and durable payout

Base: `version-16` @ `91bdc36ee2c89d90fa0e8e93521fee46bbd5de5a`.
Plan: PLAN-065.

## Current state

The POS local database already has durable `cleaner_visits`, `cleaner_cycle` and `cleaner_payouts`, including visits-since-payment and paid/pending lifecycle. Current behavior is hard-coded to 4 visits and 200000 minor units. This DEV must extend that existing model, not replace it.

## Architecture decisions

1. Point configuration gets two additive values: cleaning payout amount (money in minor units server-side) and payout cadence `every N cleanings` (positive integer). Existing points migrate/default to current behavior: 2000 RUB and every 4 cleanings. Validation rejects negative amount, zero/negative cadence and invalid precision.
2. Extend existing POS bootstrap/config cache additively so cleaning settings are available offline. If an old server/cache has no fields, POS falls back to the migration defaults above. Configuration change affects future cycle threshold calculations without deleting visit/payout history.
3. Reuse current local cleaning tables and same-day dedupe. A visit is recorded at most once for the business day according to the existing point-local date semantics. When the configured threshold is reached, create/retain one pending payout; do not reset progress as paid until payout succeeds. While payout is pending, no second same-day visit or duplicate pending payout is created.
4. Payout action reuses the existing cash-withdrawal operation with the configured amount prefilled. Only after that withdrawal has succeeded and been durably journaled may the cleaning payout be marked paid. Unknown/failed cash-withdrawal result must leave payout pending; never issue a second withdrawal blindly.
5. POS displays `Оплачено` / `Ожидает выплаты`. A pending payout raises the existing Cleaning navigation badge and parent Work badge in red until resolved.
6. Web OS point settings are an administrative configuration surface using existing point access controls. Do not add a separate cleaning ownership domain.

## Stages

1. Point configuration + sync: existing Business Point/point-settings owner model and migration in `raspechatka/**`, existing point settings API, POS bootstrap in `raspechatka/api/pos.py`/`pos_v2.py`, `pos/src/shared/contracts.ts`, `pos/src/main/frappe.ts` cache. Add defaults/backward compatibility and focused backend/contract tests.
2. POS cleaning state: `pos/src/main/database.ts` existing cleaning tables/helpers plus narrow main IPC if required. Replace hard-coded 4/200000 with cached validated config and retain same-day/pending invariants; add DB tests across restart/config absence.
3. Safe payout: existing Work/AppV2 cleaning action + existing cash-withdrawal API/journal. Prefill configured amount and mark cleaning payout paid only after successful durable withdrawal. Add duplicate/unknown/failure tests.
4. UI: existing Web OS point-settings page/components + POS `WorkPage.tsx` cleaning statuses/navigation badges. Keep Design Code CASA and existing access checks.

## Safety / migration

All schema/config changes are additive. Existing visits/cycles/payouts stay intact. Default values exactly preserve current behavior. Money uses integer minor units in contracts/persistence. Cash withdrawal and payout marking are two ordered durable facts: withdrawal success first, payout-paid second; recovery must reconcile before repeat.

## Acceptance

Old install with no new settings behaves as 4 × 2000 RUB. New per-point values reach POS offline cache. Restart/employee/shift change does not lose progress. Same-day repeat does not advance progress. Threshold produces one pending payout. Successful cash withdrawal clears it exactly once; cancel/failure/unknown does not. Pending badges disappear only after paid state.

No PR/merge/deploy during stages.