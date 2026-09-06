# Raspechatka OS — repository instructions for coding agents

These instructions apply to the entire repository. Every coding agent must read them before planning or editing.

## Source of truth

- Repository: `shuvaevnikolay-anti1801/raspechatka-os`.
- Stable integration and deployment branch: `version-16`.
- The GitHub repository is the source of truth. Chat history from another account is not.
- Read the current code and relevant files in `docs/` before making assumptions.

## Branch and pull-request discipline

1. Fetch the latest `origin/version-16` before starting.
2. Unless the user explicitly assigns an integration, merge, or release task, never commit, push, merge, force-push, or move `version-16` directly.
3. Create one short-lived branch per bounded task from the latest `origin/version-16`. Name it `codex/<task-slug>`.
4. Keep unrelated work out of the branch.
5. Open a Pull Request into `version-16`. The coding agent is the integration agent for tasks assigned directly by the repository owner in this Codex workspace: after required checks pass, it may merge its own task PR into `version-16` and let the production deployment workflow run. Do not merge when checks fail, when there is an unresolved review or merge conflict, or when the user explicitly asks for a draft/review-only delivery.
6. Before handoff, update the branch with the latest `version-16`, resolve conflicts, run the required checks, and describe the result.
7. Integration branches must be named `codex/integration-<scope>`. Only an explicitly assigned integration agent may use them.

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
