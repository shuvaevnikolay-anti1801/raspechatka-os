# Raspechatka OS — instructions for coding agents

These rules apply to the whole repository. More specific `AGENTS.md` files override/add rules for their subtree.

## Source of truth

- Repository: `shuvaevnikolay-anti1801/raspechatka-os`.
- Stable integration/deployment branch: `version-16`.
- Current repository code and docs are the source of truth. Do not rely on old chat history.
- Before editing, read the files you will touch and the nearest `AGENTS.md`.

## Delivery workflow

1. Start from the latest `origin/version-16`.
2. Never commit directly to `version-16`. Use one short-lived branch per bounded task: `codex/<task-slug>`.
3. Keep unrelated changes out of the branch.
4. Open a PR into `version-16`, update the branch from the latest base before merge, resolve conflicts, and run checks relevant to changed code.
5. Merge automatically when CI/Quality Gate pass and there are no unresolved reviews/conflicts, unless the user explicitly requested review-only/draft work.
6. A known repository-wide lint failure may be treated as baseline only after confirming the task did not introduce it. Never ignore failures caused by the task.
7. After merge, monitor expected CI/deployment when available. Stop only for missing permissions/credentials, destructive or irreversible production work, unsafe migration, material requirement conflict, or explicit user review requirement.
8. Integration branches use `codex/integration-<scope>` and only when explicitly assigned.

## Scope and architecture

- Make the smallest coherent change that satisfies the task. Do not silently broaden scope.
- Preserve compatibility and existing public contracts unless the task explicitly changes them.
- The server is a modular monolith (Frappe + one MariaDB). Do not introduce microservices or separate databases without an explicit architecture decision.
- Windows POS is a separate edge application. POS-specific rules are in `pos/AGENTS.md`.
- Frappe/backend rules are in `raspechatka/AGENTS.md`.
- Web frontend rules are in `frontend/AGENTS.md`.
- If a necessary refactor is materially larger than the task, record it as a follow-up in «Архитектор ОС» when accessible, otherwise in the PR handoff.

## External side effects and duplicate safety

For money, fiscalization, stock, durable business facts, external APIs and hardware:

- Timeouts/lost responses can mean an **unknown outcome**, not failure.
- Never blindly retry an operation that could charge, fiscalize, post stock, or create another durable effect.
- Persist enough state to reconcile unknown outcomes before retry.
- Use stable idempotency/deduplication keys where applicable; critical uniqueness must be enforced transactionally/database-side when relevant.
- Provider outages must not crash unrelated functions.
- Test failure/restart/duplicate paths, not only happy paths.

## Security and data

- Never commit credentials, tokens, production exports, customer databases, or real personal data.
- Treat client-supplied IDs as untrusted.
- Do not run destructive production operations or migrations unless explicitly authorized.

## Generated files

Feature branches may edit source files but must not commit generated frontend assets under:
- `raspechatka/public/frontend/assets/`
- `raspechatka/www/raspechatka.html`

## Verification

Run the narrowest relevant tests while developing and the required full checks for the touched area before PR completion. Do not claim runtime/hardware validation unless it actually ran.

## PR handoff

PR description/final report must state:
- business result;
- changed modules/files;
- API/schema/migration changes;
- tests actually run and results;
- known limitations and anything not physically verified;
- deployment or hardware steps, if any.
