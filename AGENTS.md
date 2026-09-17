# Raspechatka OS — repository instructions for coding agents

These instructions apply to the entire repository. Every coding agent must read them before planning or editing.

## Source of truth

- Repository: `shuvaevnikolay-anti1801/raspechatka-os`.
- Stable integration and deployment branch: `version-16`.
- The GitHub repository is the source of truth. Chat history from another account is not.
- Read the current code and relevant files in `docs/` before making assumptions.

## Branch, integration, and continuous-delivery discipline

The repository owner grants coding agents in this Codex workspace standing authorization to complete the full delivery cycle for implementation tasks: create a task branch, open a PR, verify it, merge it into `version-16`, and let the production deployment workflow run. Do not ask for a separate “merge PR” or “start deployment” confirmation unless the user explicitly requested draft/review-only work.

1. Fetch the latest `origin/version-16` before starting.
2. Never commit, force-push, or move `version-16` directly. Create one short-lived branch per bounded task from the latest `origin/version-16`, named `codex/<task-slug>`.
3. Keep unrelated work out of the branch and open a Pull Request into `version-16`.
4. Before merging, update the branch with the latest `version-16`, resolve conflicts, and run the required checks.
5. Merge automatically when CI and Quality Gate pass and there are no unresolved reviews or merge conflicts.
6. A failure of the repository-wide `Linters` workflow may be treated as a known baseline exception only after inspecting its logs and confirming that the task's changed lines did not introduce the failure. Record that exception in the PR and final report. Never ignore failures in tests, build, security checks, migration checks, or lint errors caused by the task.
7. After merging, monitor the automatic CI and production deployment for the merged `version-16` commit. If an expected run is missing and available GitHub permissions allow it, start or rerun the existing workflow without asking the user. Diagnose and fix ordinary code or workflow failures within the assigned scope.
8. Stop and ask the user only for a genuine authorization or safety boundary: credentials or permissions are missing, production requires a destructive or irreversible operation, a data migration lacks a safe compatibility plan, requirements materially conflict, or the user explicitly requested review before release.
9. Integration branches must be named `codex/integration-<scope>`. Only an explicitly assigned integration agent may use them.

## Ownership and conflict avoidance

Stay inside the module named in the task whenever possible:

- sales: `raspechatka/api/sales.py`, sales DocTypes, `frontend/src/pages/SalesPage.vue`
- team: `raspechatka/api/team.py`, employee/payroll/schedule/motivation DocTypes, `frontend/src/pages/TeamPage.vue`
- finance: `raspechatka/api/finance.py`, finance DocTypes and finance pages
- warehouse: warehouse API, warehouse DocTypes and warehouse pages
- clients: client/club/marketing API, DocTypes and client pages
- references: reference APIs, reference DocTypes and reference pages

The following are shared conflict hotspots. Make only small additive changes and never replace them wholesale:

- `frontend/src/App.vue`
- `frontend/src/router.js`
- `raspechatka/www/raspechatka.py`
- `raspechatka/patches.txt`
- access-control code and settings
- shared CSS and generic components

If another open PR edits the same DocType or hotspot, stop and report the dependency or coordinate through an integration task.

## Modular monolith and domain boundaries

The central Raspechatka OS is intentionally a **modular monolith**: one Frappe deployment and one MariaDB database, with business domains separated by responsibility. Do not introduce microservices, a database per domain, or a separate Frappe app per domain without a new explicit architecture decision.

Core domain boundaries currently include catalog, sales, warehouse, clients, finance, team, access/references, and integrations. A domain owns its business invariants and all state-changing logic for the records it owns.

1. **Every domain must have a public gateway.** Represent it with explicit service/facade/module functions or another clear contract owned by that domain. Other domains call this gateway instead of reaching through internal implementation details.
2. **Cross-domain writes must go through the owner domain.** Feature code must not directly create, update, delete, submit, cancel, or execute SQL writes against DocTypes/tables owned by another domain. For example, Sales may request a stock movement through the Warehouse/Stock service; it must not implement its own direct `Stock Ledger Entry` mutation.
3. **Cross-domain reads should prefer public query/service functions.** Read-only reporting and analytics may directly query another domain's records when that is materially simpler and no invariant can be changed. Keep such reads isolated, documented by purpose, and strictly free of writes.
4. **Multi-domain workflows use coordinators, not ownership leakage.** A sale may coordinate Sales, Warehouse, Clients, and Finance, but the coordinator calls each domain's gateway. It must not copy the internal rules of those domains into itself.
5. **Whitelisted Frappe methods are an external boundary, not the only internal contract.** Internal Python code should normally call domain services directly rather than making HTTP calls back into the same application.
6. **Keep domain-specific code inside its domain.** Put only genuinely reusable, domain-neutral behavior into shared helpers/components. Do not create a generic shared abstraction merely to avoid a small amount of duplication.
7. **Split by responsibility, not by arbitrary file size.** Refactor when one file/component owns several independent workflows, screens, or business responsibilities, or when unrelated changes repeatedly collide in the same file. Do not split code only to satisfy a line-count target.
8. **Preserve compatibility while splitting.** Prefer incremental extraction behind existing APIs/contracts over a big-bang rewrite.

### POS boundary

The Windows POS is a separate edge application, not another module inside the server monolith. Keep the Electron `main`, `preload`, `renderer`, and `shared` boundaries and keep hardware behind provider contracts. New independent POS screens/workflows must not continue accumulating in the root `AppV2` component; extract Sale, Receipts, Orders, Shift, Work, Settings, and future workflows into focused components/modules as they are materially developed.

### Team boundary

Do not keep expanding one undifferentiated `team.py`. When the Team area grows, preserve separate subdomain responsibilities for employees, schedule/shift planning, motivation, and payroll. Accounting/tax calendar/reporting should receive its own domain or explicit subdomain boundary when implemented, even if the navigation groups it near Team.

### Architectural follow-ups

If an implementation task exposes a necessary structural refactor that is larger than the current task, do not silently expand scope. Record it as a follow-up in **«Архитектор ОС» → «02 План»** when that project source is accessible; otherwise record it explicitly in the PR handoff/final report so it can be added to the plan. Small safe extractions required to keep the current change inside the rules above are allowed.

## Access control contract — mandatory

Raspechatka OS uses one mandatory two-layer model for Web OS access. **Role** answers which `page.*` page/action is allowed (`None`, `View`, `Edit`, `Admin`). **Scope** answers which business data is visible (`Network`, `Partner`, `Business Entity`, `Points`). Do not introduce a parallel third access model without an ADR.

1. `frontend/src/access-pages.json` is the canonical Web OS page registry. Every new Web OS page must have a unique `page.*` access area and route. Ordinary work roles are deny-by-default for new pages.
2. Every new or materially changed `@frappe.whitelist` endpoint must declare `@access_contract(...)`. Session endpoints declare `area`, `action`, and `scope`; POS/webhook/OAuth/public endpoints declare their explicit alternative `auth` type. Quality Gate enforces this contract.
3. Session `@access_contract` enforces the declared `require_access(area, action)` at the backend boundary. Frontend route/menu hiding is UX only and is never the security boundary.
4. Scope filtering must use shared helpers from `raspechatka.scope` (or a domain-owned wrapper that is at least as strict). Prefer point scope for point-owned documents.
5. Partner scope is always potentially multi-entity. Never assume `scope["business_entity"]` is populated for a Partner. Use `business_entities` or `scope["points"]`.
6. List, detail, create, update, delete, options, dashboards, aggregates, and reports must apply the same scope boundary. Client-supplied object IDs, entity IDs, or point IDs are never proof of authorization.
7. Guest/POS/webhook/OAuth endpoints must bind authorization to trusted server-side context such as authenticated POS Connection point, verified webhook secret, signed OAuth state, or a server-issued client token.
8. Scoped modules must cover negative access: foreign partner/entity/point/document IDs. The standard regression case is Partner A with two entities and three points versus Partner B with another entity/point.
9. Read `docs/access-control-contract.md` before adding or changing an external API. Untouched legacy endpoints remain covered by `docs/api-authorization-inventory.md` and migrate to explicit contracts when touched.

## External integrations and graceful degradation

Treat every external HTTP API, SaaS, webhook source, payment/fiscal device provider, and similar dependency as potentially slow, unavailable, duplicated, or capable of returning an unknown outcome. An external outage must not become an outage of unrelated Raspechatka OS functions.

1. **Define failure behavior before implementing an integration.** State the source of truth, sync direction, business criticality, degraded mode, and recovery/reconciliation path.
2. **Block only what truly depends on the provider.** If a bank, messaging service, video service, or other auxiliary provider is down, unrelated sales, warehouse, clients, and other domains must keep working. A card-payment or legally required fiscal operation may block that specific operation, but must not crash or freeze the POS application.
3. **Use bounded timeouts and fail fast.** Never leave a user request waiting indefinitely for an external service. Safe retries use exponential backoff with jitter and must not create a retry storm.
4. **Do not silently lose required external work.** When delivery must eventually happen, persist the intent in a durable queue/outbox/inbox or equivalent state before/around the external call, expose pending/failed state, and support automatic plus manual retry/recovery.
5. **Make retries idempotent.** External creates, payments, webhooks, imports, and sync operations need stable idempotency/deduplication keys whenever the provider/process permits it. Duplicate delivery must be harmless.
6. **Unknown financial/fiscal outcomes require reconciliation, not blind retry.** Preserve the operation in a recovery state and verify the provider result before any repeat that could charge or fiscalize twice.
7. **Sync integrations must catch up after outages.** Persist cursor/checkpoint state and use an overlap/backfill strategy where the provider API permits it, so temporary downtime delays data rather than losing it.
8. **Separate connection/auth state from operational health.** A transient timeout or 5xx must not permanently convert a valid authorization into a disconnected state. Re-authorization is required only when credentials/consent are actually invalid.
9. **Expose integration health.** Keep useful fields/metrics such as last successful contact/sync, last error, stale/degraded state, pending/retry count, next retry, and alert after a meaningful failure threshold. UI that shows cached/last-known data must make staleness clear when it matters.
10. **Incoming webhooks are authenticated, deduplicated, and retry-safe.** Persist/process them so repeated provider delivery cannot duplicate business effects; acknowledge quickly when long processing can be deferred.
11. **Test the failure path.** Integration work is not complete with happy-path tests only. Cover timeout/offline, provider 5xx or equivalent, duplicate delivery, process restart at dangerous boundaries, and successful recovery when the dependency comes back.
12. **Record larger resilience debt.** If making an existing integration compliant is larger than the current task, record the follow-up in **«Архитектор ОС» → «02 План»** or, if inaccessible, in the PR handoff/final report.

## Idempotency and duplicate safety

Assume every state-changing command can be delivered more than once because of a lost response, user double-click, browser retry, queue redelivery, worker restart, webhook retry, POS outbox replay, scheduler overlap, or multiple backend servers behind a load balancer. Duplicate delivery must not create duplicate business effects.

1. **Classify every write command before implementation.** Any command that creates or changes a sale, return, payment, cash movement, bank operation, stock movement, stock document, purchase order, supplier allocation, payroll result, external message, fiscal operation, or another durable business fact must explicitly decide how duplicate delivery is handled.
2. **Use a stable idempotency key for retryable creates.** The caller generates the key once per logical action and reuses it for every retry. Do not generate a fresh key inside each retry. For imported/provider data prefer the provider's immutable operation ID; otherwise use a UUID or deterministic business key whose semantics are documented.
3. **Enforce uniqueness in MariaDB for critical effects.** `if not exists: insert` is not sufficient under concurrency. The final protection for money, stock, sales, returns, imported operations, and other critical facts must be a UNIQUE field/index or another transactional constraint owned by the database.
4. **Return the original result on a duplicate request.** A successful command retried with the same idempotency key should normally return the already-created document/result rather than create another record or fail with a generic duplicate error.
5. **Reject key reuse with different payload.** If the same idempotency key is presented with materially different amount, entity, items, direction, or other protected input, stop and require investigation instead of silently accepting the changed request.
6. **Protect derived side effects independently.** Idempotency of the parent document is not enough. Stock ledger rows, finance postings, client-history rows, profitability rows, audit actions, notifications, and other effects produced by hooks/workflows need their own deterministic source key or UNIQUE protection where re-execution could duplicate them.
7. **Make submit/cancel/post transitions retry-safe.** Repeating a command after the requested state is already reached should return the current successful state when the same operation is being retried. Use row locks or equivalent transactional serialization when two workers can attempt the same transition concurrently.
8. **Do not rely on frontend button disabling.** UI guards improve UX but are never the correctness boundary. The server/database must remain safe if two identical requests arrive simultaneously from different browser tabs, workers, POS devices, or backend instances.
9. **Unknown external money/fiscal outcomes are not ordinary retries.** Preserve recovery state and reconcile with the provider before repeating any charge, refund, or fiscalization that could execute twice.
10. **Queues, schedulers and sync jobs must tolerate overlap.** Either deduplicate the job itself or make every consumed item idempotent and concurrency-safe. Duplicate jobs may waste work but must not duplicate business facts or corrupt status counters.
11. **Test duplicates and races.** For every critical command add coverage for sequential retry after success, lost-response retry, same key with changed payload, and concurrent duplicate execution where practical.
12. **Do not introduce new idempotency debt silently.** If a touched critical command lacks the protection above and fixing it is larger than the current task, record a follow-up in **«Архитектор ОС» → «02 План»** before completing the work.

## Generated frontend assets

Feature branches must edit source files under `frontend/`, but must not commit generated files under:

- `raspechatka/public/frontend/assets/`
- `raspechatka/www/raspechatka.html`

The explicitly assigned integration agent runs the production frontend build after combining PRs and commits the generated assets in the integration commit. This prevents parallel branches from conflicting on hashed bundle names.

## Standard list pages

Before creating or changing a standard Filter → Table → entity-card page, read `docs/list-workspace.md`. Define one `entityFields` descriptor for business-visible fields and derive form, filter, and table presentations from it. Do not maintain parallel `formFields`, `filterFields`, and `tableColumns` arrays for the same entity. Search is a permanent special filter declared by the page, while Frappe DocType metadata may enrich declared fields but must never add UI fields on its own. Use the existing `SmartFilterBar` and `SmartDataTable`, including preference reconciliation and column-order persistence.

Standard tables display business labels, not storage values. Reuse descriptor `options` for Select labels, declare `displayKey` for Link labels, and keep raw IDs/codes unchanged for API and persistence. List endpoints must hydrate Link labels with joins or batched queries; never add per-row lookup requests. Custom slots/formatters take precedence over the shared display resolver.

## Frappe data and migrations

- Do not delete or rename a DocType or persisted field without an explicit migration and compatibility plan.
- Every schema patch must have a unique descriptive filename, be safe to run more than once, and be appended once to `raspechatka/patches.txt`.
- Do not reorder or remove older patch lines.
- Validate links between network, business entity, point, warehouse, employee, client, supplier, sales, and finance records.
- Apply access checks and point/entity scope to every new whitelisted API.
- Never put credentials, tokens, real personal data, production exports, or customer databases in Git.
- Do not run migrations against the user's main site unless the user explicitly requests deployment. Use a separate test site when available.

## Required checks

Run from the repository root:

```bash
python - <<'PY'
import ast
import json
from pathlib import Path

for path in Path("raspechatka").rglob("*.py"):
    ast.parse(path.read_text(), filename=str(path))
for path in Path("raspechatka").rglob("*.json"):
    json.loads(path.read_text())
print("Python and JSON validation passed")
PY

python -m tabnanny raspechatka
python scripts/check_access_contract.py

cd frontend
npm ci
npm run build
```

When a Frappe test site is available, also run the relevant migration and application tests. Never claim runtime validation if only static checks were run.

## Pull Request handoff

Every PR description must state:

- business result;
- modules and DocTypes changed;
- API or schema changes;
- migration/patch added;
- shared hotspot files changed;
- tests actually run and their results;
- known limitations;
- deployment steps, if any.

Do not describe placeholders as finished functionality. Preserve unrelated user changes and existing modules.
