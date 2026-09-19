# Web frontend — coding agent instructions

Applies to `frontend/**`. Also follow root `AGENTS.md`.

## Structure and access

- `frontend/src/access-pages.json` is the canonical Web OS page registry.
- Every new Web OS page needs a unique `page.*` access area/route; ordinary roles are deny-by-default.
- Route/menu visibility is UX only; backend remains the security boundary.
- Shared hotspots (`App.vue`, `router.js`, shared CSS/components) should receive small additive changes, not wholesale replacement.

## Standard lists

Before creating/changing a standard Filter → Table → entity-card page, read `docs/list-workspace.md`.

- Define one `entityFields` descriptor and derive form/filter/table views from it.
- Use existing `SmartFilterBar` and `SmartDataTable`.
- Display business labels while preserving raw IDs/codes for API/persistence.
- Avoid per-row lookup requests; hydrate labels with joins/batched queries.
- Preserve saved column order/preferences and declared search behavior.

## Build

From `frontend/`:
```bash
npm ci
npm run build
```

Do not commit generated bundles under `raspechatka/public/frontend/assets/` or `raspechatka/www/raspechatka.html` from feature branches.
