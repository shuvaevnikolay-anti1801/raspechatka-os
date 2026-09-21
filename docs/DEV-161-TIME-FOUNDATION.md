# DEV-161 — Canonical time foundation: site/user/point timezones, POS instants and historical repair

## Why this DEV exists

DEV-160 standardized much of Web OS date formatting, but production still has a deeper time-contract defect.

Frappe v16 stores `Datetime` as timezone-naive wall clock in one **system/site timezone**. Its `now_datetime()` uses `System Settings.time_zone`; if that value is absent, Frappe silently falls back to `Asia/Kolkata`.

The current Raspechatka code has three incompatible paths:

1. Server-created documents use Frappe `now()/now_datetime()` and therefore the Frappe system timezone (or its India fallback).
2. DEV-160 Web boot independently used `System Settings.time_zone or "UTC"`, so an unset site timezone can be written as India time and then displayed as if it had been UTC.
3. Windows POS correctly transports many event timestamps as UTC ISO/RFC3339 (for example `2026-09-21T15:00:00.000Z`), but server ingest currently assigns those strings directly to Frappe `Datetime`. Frappe serializes the wall-clock portion and drops timezone awareness, so a UTC instant can be persisted as a naive site-local value without conversion.

This can create timestamps in the future/past, wrong local dates near midnight, incorrect shift/day classification and historical records that cannot safely be grouped.

## Canonical model

The project will use the time model that fits Frappe's actual database semantics instead of fighting them.

### 1. Instant

An **instant** is an absolute moment. Every timestamp crossing an external boundary (Windows POS, external API, transport payload) uses RFC3339/ISO-8601 with an explicit offset, preferably UTC `Z`.

Examples:
- valid transport: `2026-09-21T15:00:00.000Z`
- valid transport: `2026-09-21T18:00:00+03:00`
- invalid new transport: `2026-09-21 18:00:00` (ambiguous, no offset)

### 2. Frappe site timezone

Frappe `Datetime` columns remain timezone-naive and represent wall clock in one explicit, stable **site timezone**.

- Do not migrate the framework to timezone-aware DB columns.
- Do not store UTC `Z` wall clock directly into a Frappe `Datetime`.
- Before persistence, external instants are converted to the configured site timezone and made naive.
- When exporting a Frappe `Datetime` across a system boundary, interpret it in site timezone and serialize it back as UTC RFC3339.
- `System Settings.time_zone` must never be empty after DEV-161. Application code must never invent a different fallback.

Initial normalization rule for the existing installation:
1. If a valid configured site timezone exists, preserve it.
2. Treat `Asia/Kolkata` as the known accidental Frappe fallback only when active Business Points demonstrate that it is not a real site choice.
3. If site timezone is absent and all active points with a timezone agree, use that timezone (current production is expected to resolve to `Europe/Moscow`).
4. If no single point timezone can establish a legacy site timezone, use `UTC` as the technical canonical timezone rather than guessing one partner's locality.
5. Once normalized, adding/changing points must **not** silently change the site timezone. A later site-timezone change would require another explicit migration.

### 3. User timezone

`User.time_zone` is the user's display timezone.

- Effective display timezone = current Frappe User timezone, fallback to the configured site timezone.
- Generic Web OS timestamps display in the effective user timezone.
- User timezone changes presentation, not stored facts.
- Do not add a duplicate Raspechatka user-timezone field.

### 4. Business Point timezone

Existing `Business Point.timezone` is the point's business-local timezone.

It is authoritative for:
- local calendar day of a sale/shift;
- first/subsequent shift on a point-local day;
- point-local date boundaries in operational reports;
- schedules and other explicit point-local concepts.

It is **not** the storage timezone and must not rewrite the same instant differently for different points.

### 5. Date-only values

Frappe `Date` values are calendar dates, not instants. Never send them through UTC conversion.

## Shared server time contract

Create a compact `raspechatka/time_contract.py` (name may vary slightly) with focused primitives, covered by tests:

- configured/validated site timezone resolver;
- point timezone resolver with explicit fallback policy;
- parse RFC3339/offset-aware external instant;
- external instant -> Frappe site-naive datetime;
- Frappe site-naive datetime -> UTC RFC3339;
- Frappe site-naive datetime -> target/user/point-local aware datetime/date;
- point-local start/end date bounds -> Frappe site-naive bounds;
- timezone validation via IANA `ZoneInfo`.

Do not scatter ad-hoc `replace(tzinfo=...)`, `fromisoformat`, or timezone assumptions through APIs.

## Web OS contract

DEV-160 frontend formatting remains conceptually valid, but Web boot must use the exact same system timezone resolver as Frappe.

Boot exposes:
- `system_timezone`: configured/effective Frappe site timezone;
- `effective_user_timezone`: current user's `User.time_zone` or site timezone;
- compatibility alias `user_timezone` only while existing frontend code needs it.

No `or "UTC"` fallback may disagree with Frappe.

Add admin-visible diagnostics showing:
- configured site timezone;
- effective site timezone;
- current user's timezone/effective timezone;
- active points and their timezones;
- warning if legacy fallback/mismatch is detected.

The existing Users editor should allow an administrator to edit the linked Frappe User `time_zone` using IANA values. This is not a new user field.

## POS transport contract

Windows POS keeps local persistence/journal timestamps as UTC ISO strings, as it already generally does.

Server bootstrap should include the current point timezone.

Every POS timestamp ingress that represents an instant must pass through the shared converter before assigning a Frappe `Datetime`, including, as applicable:
- Sales Shift `opened_at` / `closed_at`;
- Sales Receipt `posting_datetime`;
- Cash Movement `posting_datetime`;
- POS Order `created_at`, `due_at`, `ready_at`, `issued_at`;
- POS Cash Count `counted_at`;
- other POS event timestamps discovered in the audited ingest paths.

Every server -> POS datetime that is an instant must be serialized as UTC RFC3339 instead of `str(naive_datetime)`.

New v2 POS events must not silently accept an offset-less timestamp as an instant. Preserve legacy compatibility only where an existing older endpoint demonstrably needs it, and make that interpretation explicit/tested.

## Point-local business day

Fix current code that mixes UTC, site-naive and point-local dates.

In particular, `raspechatka.sales.resolve_shift_type()` currently treats a naive Frappe value as UTC and queries a point-local date against site-local stored values. Replace this with shared helpers.

For the sales operational chain, add an explicit read-only/indexed `business_date` where it materially simplifies and stabilizes point-local grouping:
- Sales Shift;
- Sales Receipt;
- Cash Movement;
- Cashier Action.

`business_date` is derived from the event instant in `Business Point.timezone` and is not user-editable. Use it for point-local day filtering/grouping and first/subsequent shift logic. Backfill it in the historical repair.

Do not add business_date indiscriminately to unrelated reference/configuration DocTypes.

## Historical repair

Historical repair is part of DEV-161 and must be automatic for records where the correction is provable.

### Safety rule

Never implement a blanket “subtract N hours from everything”.

There are at least two different historical error classes:

1. **Legacy Frappe-site wall clock**: server-created timestamps generated with an incorrect/implicit Frappe site timezone (for example the `Asia/Kolkata` fallback). Repair by interpreting the stored wall clock in the actual historical site timezone and converting the same instant to the new canonical site timezone.
2. **POS UTC wall clock stored as site-naive**: POS sent a valid UTC/offset instant but ingest stored the wall-clock portion directly in Frappe. Repair by interpreting the affected stored field as UTC and converting to canonical site timezone.

These transformations are different and must never be mixed.

### Evidence and epochs

Use Frappe `Version` history for `System Settings` to reconstruct known `time_zone` changes when available.

- Capture a repair cutoff before mutation.
- If the legacy site timezone is unambiguous for an epoch, repair Frappe-generated timestamps in that epoch.
- If timezone history is ambiguous, do not guess for affected rows; report them as unresolved instead of modifying them.
- A missing timezone with no recorded history means the Frappe runtime fallback was `Asia/Kolkata`.
- POS-origin fields with a known UTC-as-naive ingest path can be repaired independently of the old site timezone.

### Initial repair registry

The repair implementation must maintain an explicit registry/classification, not a repo-wide blind Datetime loop.

At minimum audit/repair:
- standard `creation` and `modified` for Raspechatka-owned operational/reference DocTypes when the historical site-timezone epoch is provable;
- Client `registered_at` when it was server-generated (use evidence such as close match to creation; do not alter imported explicit historical values blindly);
- Sales Shift POS `opened_at` / `closed_at`;
- Sales Receipt POS `posting_datetime`;
- Cash Movement POS `posting_datetime`;
- Cashier Action `action_datetime` by re-deriving from its repaired reference document where possible;
- POS Order POS `created_at` / `due_at` / `ready_at` / `issued_at`;
- POS Cash Count `counted_at`;
- POS-created Stock Write Off / Stock Receipt server-generated posting datetime as legacy site-wall-clock values;
- any additional field discovered by the focused audit with equally strong provenance.

Do **not** alter:
- Date-only fields;
- external-source timestamps whose source semantics are not proven (for example an imported/MoySklad timestamp without an established contract);
- arbitrary user-entered historical datetimes solely because they look unusual.

### Repair process

Implement a reusable repair service plus one migration patch.

The service:
1. builds a deterministic dry-run plan;
2. reports counts by DocType/field/error class plus before/after examples;
3. hashes/identifies the plan;
4. applies only safe classifications in batches, preserving links and using direct DB updates with `update_modified=False` semantics where appropriate;
5. backfills sales `business_date`;
6. is idempotent and stores an internal contract-version marker;
7. writes a durable private JSON audit report through Frappe `File` (before/after summary, source/target timezone, cutoff, counts, unresolved classes, plan hash);
8. clears relevant caches after system timezone normalization.

The migration patch should automatically apply the safe plan during deploy. It must fail before partial mutation if core assumptions are contradictory. Ambiguous non-core rows may remain reported/unmodified rather than blocking the entire deployment.

Audit any code that uses `modified` as an incremental cursor before changing historical `modified`; reset/reconcile the application's own affected cursor if necessary.

## Delivery parts

1. **DEV-161 (1) — Canonical site-time foundation and shared server helpers.**
2. **DEV-161 (2) — POS UTC transport normalization and point timezone bootstrap.**
3. **DEV-161 (3) — Point-local business day and sales/shift semantics.**
4. **DEV-161 (4) — User timezone management and time diagnostics in Web OS.**
5. **DEV-161 (5) — Historical audit, automatic repair and migration.**

All parts are sequential in the same branch `codex/dev-161-time-foundation`. No intermediate PR/merge/deploy/full CI. Architect reviews factual diff after every part. Full tests/build/Windows package, one PR, merge and production deploy occur after (5).

## Final acceptance

- `System Settings.time_zone` is explicitly configured and Web boot cannot disagree with Frappe about the site timezone.
- A server-created document's current time is correct relative to the configured site timezone.
- A UTC POS event round-trips POS -> server -> POS as the same instant.
- Moscow example: `15:00Z` persists as `18:00` when site timezone is `Europe/Moscow`, and displays correctly for Moscow and a different user timezone.
- Browser/Windows local timezone cannot silently change a server fact.
- Point-local business date uses `Business Point.timezone`, including around midnight and DST-capable zones.
- First/subsequent shift logic and sales date filtering no longer assume naive Frappe values are UTC.
- Administrator can see system/user/point timezones and edit the user's existing Frappe timezone.
- Historical safe classes are corrected automatically; the migration produces a durable audit report and is idempotent.
- Historical ambiguous values are explicitly reported, never shifted by guesswork.
- Date-only values are unchanged.
- No payment/fiscal amount, stock quantity, receipt monetary value, or external transaction is replayed during repair.
