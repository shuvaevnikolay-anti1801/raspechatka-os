# Access Control Contract

Raspechatka OS uses exactly two access layers for Web OS business data.

1. **Role** answers: which page is available and which action is allowed (`None`, `View`, `Edit`, `Admin`).
2. **Scope** answers: which business data is visible inside an allowed page (`Network`, `Partner`, `Business Entity`, `Points`).

Do not introduce a parallel third access model without an ADR.

## Pages and deny-by-default

`frontend/src/access-pages.json` is the canonical Web OS page registry. Every new page must have a unique `page.*` access area and route. New page rules are created with `None` for ordinary work roles. `Raspechatka Cashier` remains POS-only with immutable `None` Web OS page access.

## External API contract

Every new or materially changed `@frappe.whitelist` endpoint must declare a machine-readable `@access_contract(...)` decorator.

Session example:

```python
@frappe.whitelist()
@access_contract(area="page.sales.receipts", action="read", scope="point")
def get_receipts(...):
    ...
```

Alternative-auth example:

```python
@frappe.whitelist(allow_guest=True)
@access_contract(auth="pos_token", scope="pos_point")
def push_batch(...):
    ...
```

Supported auth types are `session`, `pos_token`, `webhook`, `oauth_state`, `public_token`, `current_user`, and `guest`. `guest` is reserved for intentionally public endpoints such as the rate-limited OS login endpoint; it must never expose business data. Session contracts enforce `require_access(area, action)` automatically. Alternative auth endpoints must authenticate and bind their own trusted context (for example POS Connection point or signed OAuth state).

The Quality Gate compares the PR against `version-16`. A newly added or materially changed whitelisted endpoint without a valid contract fails CI. Untouched legacy endpoints remain covered by `docs/api-authorization-inventory.md` and migrate to explicit decorators as they are changed.

## Scope rules

Backend is the security boundary. Frontend filtering is UX only.

Use shared helpers from `raspechatka.scope` instead of reimplementing scope logic in each module:

- `allowed_entities()`
- `allowed_points()`
- `entity_filter()`
- `point_filter()`
- `ensure_entity_allowed()`
- `ensure_point_allowed()`

Partner scope is always treated as potentially multi-entity. Never assume `scope["business_entity"]` is populated for a Partner. Use `business_entities` or, for point-owned documents, prefer `scope["points"]`.

List, detail, create, update, delete, options, dashboard, aggregate, and report endpoints must apply the same data boundary. An object ID supplied by the client is never proof of authorization.

## Standard regression scenario

Any scoped domain should be testable against this model:

- Partner A
  - Entity A1 → Point 1, Point 2
  - Entity A2 → Point 3
- Partner B
  - Entity B1 → Point 4

A Partner A user must be able to access A1/A2 and Point 1/2/3 according to page permissions, and must not see or mutate B1/Point 4. Business Entity scope sees only one entity and its points. Points scope sees only explicitly assigned points. Network sees all data allowed by its role.

## Definition of done for future modules

A new Web OS module is not complete until:

- its pages exist in `access-pages.json`;
- its session endpoints declare `page.*`, action, and scope through `@access_contract`;
- guest/POS/webhook/OAuth endpoints declare their alternative auth type;
- entity/point filtering uses shared scope helpers or an equally strict domain-owned wrapper;
- negative tests cover foreign entity/point/document IDs when the module handles scoped data.
