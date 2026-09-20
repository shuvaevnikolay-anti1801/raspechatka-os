# DEV-157 — Repair imported MoySklad catalog variants

## Goal

Repair the one-time MoySklad catalog import so source modifications become real Raspechatka OS `Variant` items and safely repair already imported records without recreating catalog items manually.

The initial concrete case is `Футболка Стандарт`: one base product and 35 source modifications (size/color combinations). The repair must be generic for every imported MoySklad variant proven by its stored source payload.

## Current defect in stable

Stable branch at design time: `version-16`, HEAD `a640029a0a8a12a89934d604ca0b8ecb41d8abc4`.

In `raspechatka/api/moysklad.py`:

- `entity/variant` rows are read correctly;
- the variant loop calls `_safe_upsert_item(..., "Product", ..., variant_of=...)`;
- `_upsert_item` therefore writes `item_type = Product`;
- `CatalogItem._validate_variant()` clears `variant_of` and `variant_values` for every non-Variant item;
- group is read from the variant row's own `productFolder`, which is normally absent because the group belongs to the parent product;
- source `characteristics` are copied only into generic `attributes`, not into canonical `variant_values`.

Result: MoySklad modifications were persisted as independent Product cards, often with no group and no parent relationship.

The later patch `simplify_catalog_card_and_units._migrate_existing_variants()` cannot repair these rows because it only sees records that already have `variant_of`.

## Target model

Use the existing catalog model; do not add a new entity.

For each MoySklad variant:

- `Catalog Item.item_type = "Variant"`;
- `variant_of` points to the existing parent `Catalog Item` resolved by the parent MoySklad UUID;
- `variant_values` contains the source characteristics such as size and color;
- `catalog_group` and `stock_uom` inherit from the parent;
- `default_supplier` inherits from the parent only when the variant does not have its own value;
- the parent `has_variants` is recomputed from linked active variants.

Do not encode variant parameters into a new persistent product name purely to make the repair work. The canonical parameter data belongs in `variant_values`. Existing imported names remain unchanged.

## Import fix

Correct the one-time importer so future/resumed imports:

1. pass `Variant`, not `Product`, for `entity/variant`;
2. build `variant_values` from `characteristics` before `doc.save()`;
3. preserve generic imported attributes/source payload for compatibility;
4. rely on the existing `CatalogItem` validation to inherit group/UOM/supplier and reject invalid parents/duplicate signatures.

No regular MoySklad catalog sync is introduced.

## Existing-data repair

Add one idempotent Frappe patch appended once to `raspechatka/patches.txt`.

The patch must not call MoySklad. It uses only stored `Catalog Item.moysklad_payload_json` and `moysklad_id`.

### Candidate proof

A row is repairable only when its stored payload unambiguously identifies a MoySklad variant, using source metadata/href/type plus a valid parent product reference.

Do not infer variants from title text such as parentheses, size names, colors, or duplicate names.

### Preflight before mutation

For every candidate that needs repair, resolve and validate:

- parseable source payload;
- source parent UUID;
- exactly one parent `Catalog Item` with matching `moysklad_id`;
- parent is a Product;
- non-empty source characteristics;
- no conflicting existing `variant_of`;
- no conflicting canonical variant signature under the parent.

If a candidate is ambiguous or conflicting, fail the patch before destructive conversion rather than guessing.

### Mutation

Keep the existing `Catalog Item.name` and all linked business/history rows.

For a proven broken imported variant:

- change `item_type` in place from Product to Variant;
- set `variant_of` to the resolved parent;
- copy parent `catalog_group` and `stock_uom`;
- inherit parent supplier only if needed;
- create canonical `Catalog Variant Value` rows from source characteristics when they are absent;
- recompute `has_variants` on touched parents.

This is a migration-only controlled type correction; it intentionally bypasses ordinary UI immutability while preserving all persistent IDs.

### Must preserve

Do not recreate or rename the Catalog Item and do not delete/recreate:

- Catalog Item Price;
- Catalog Assortment;
- barcodes/packaging;
- stock ledger/history;
- Sales Receipt / Purchase / Warehouse links;
- MoySklad IDs and raw source payload;
- historical transaction references.

## Runtime consequences

Existing POS logic already excludes an active parent when `has_variants = 1` and treats a Variant as a sellable product. After the repair, the parent is no longer sold as a separate SKU when it has active variants, while the variants retain their existing prices/assortment/stock identity because their Catalog Item IDs do not change.

The Web catalog already exposes `catalog_group`, `variant_of`, and the parent card's variant list. No redesign is required for the core repair.

## Tests

Focused coverage must include:

- importer uses `Variant` for `entity/variant`;
- characteristics become canonical `variant_values`;
- imported Variant inherits the parent's group/UOM;
- repair candidate detection is based on stored payload, not item name;
- repair is idempotent;
- missing/ambiguous parent or empty characteristics fail closed;
- manually corrected/non-conflicting Variant is not corrupted;
- Catalog Item name/ID remains unchanged;
- parent `has_variants` becomes true;
- POS regression: parent with variants is omitted, linked Variant remains available when assortment/price permit it.

## Non-goals

- no catalog re-import;
- no new catalog entity;
- no manual recreation of 35 T-shirt modifications;
- no renaming of Catalog Item IDs;
- no price/stock/assortment migration;
- no changes to sales, fiscalization, payments, returns, or warehouse transaction logic;
- no regular MoySklad synchronization.

## Delivery stages

### DEV-157 (1) — importer semantics

Correct MoySklad variant import and add narrow tests. No data migration yet.

### DEV-157 (2) — existing-data repair

Add the idempotent preflighted patch and migration tests/contract checks. Preserve all IDs and linked records.

### DEV-157 (3) — catalog/POS regression hardening

Verify and, only where necessary, minimally adjust catalog/POS presentation/query behavior after real Variant links exist. Add focused regression tests; no redesign.

Final full CI/PR/merge/deploy is performed once after all three stages and architect review.
