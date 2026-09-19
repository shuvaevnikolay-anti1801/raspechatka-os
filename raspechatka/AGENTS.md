# Frappe backend — coding agent instructions

Applies to `raspechatka/**`. Also follow root `AGENTS.md`.

## Domain boundaries

Raspechatka OS is a modular monolith. Domains own their business invariants and state-changing logic.

- Cross-domain writes go through the owner domain's service/gateway, not direct DocType/SQL mutation from another domain.
- Prefer public query/service functions for cross-domain reads; reporting-only direct reads must remain read-only and isolated.
- Multi-domain workflows coordinate domain gateways instead of copying another domain's rules.
- Preserve compatibility when extracting/refactoring; split by responsibility, not arbitrary line count.

## Access control

Read `docs/access-control-contract.md` before adding or materially changing an external API.

- Every new/materially changed `@frappe.whitelist` endpoint must declare `@access_contract(...)`.
- Session endpoints declare page/action/scope; POS/webhook/OAuth/public endpoints declare explicit alternative auth.
- Frontend hiding is UX, not authorization.
- Scope filtering uses shared scope helpers; partner scope may contain multiple business entities.
- Client-provided point/entity/document IDs are not proof of access.
- Cover negative access to foreign partner/entity/point/document data.

## Data and migrations

- Do not delete/rename persisted DocTypes/fields without explicit migration and compatibility plan.
- Schema patches must be uniquely named, idempotent and appended once to `raspechatka/patches.txt`; never reorder old patches.
- Preserve links among network, business entity, point, warehouse, employee, client, supplier, sales and finance records.
- Critical money/stock/sale/return effects need retry/concurrency safety and database uniqueness where applicable.

## Checks

From repository root:
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
```

Run relevant Frappe tests/migrations on a test site when available; never claim them if not run.
