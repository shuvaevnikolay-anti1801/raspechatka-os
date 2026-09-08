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

## Generated frontend assets

Feature branches must edit source files under `frontend/`, but must not commit generated files under:

- `raspechatka/public/frontend/assets/`
- `raspechatka/www/raspechatka.html`

The explicitly assigned integration agent runs the production frontend build after combining PRs and commits the generated assets in the integration commit. This prevents parallel branches from conflicting on hashed bundle names.

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
