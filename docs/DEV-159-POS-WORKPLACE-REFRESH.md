# DEV-159 — Windows POS workplace refresh

## Status

Architecture prepared on 2026-09-20.

- Repository: `shuvaevnikolay-anti1801/raspechatka-os`
- Stable baseline: `version-16` @ `56eee61793de4c8599a731ba6971391607e5019a`
- Working branch: `codex/dev-159-pos-workplace-refresh`
- All implementation parts run sequentially on this one branch.
- No intermediate PR, merge, deploy, full CI or Windows packaging. Architect reviews each part; full verification/PR/merge/deploy happens once after all parts.

## Business result

Make the Windows POS calmer and more useful as a cashier workplace without creating parallel business models:

1. Correct app/browser branding assets.
2. Simplify cashier selection/PIN login and transient notifications.
3. Replace Work → Today with a read-only point work schedule plus the active cashier's next five shifts.
4. Merge Work → Products & stock and Deliveries into one page.
5. Use the complete operational catalog independently from the POS sale assortment.
6. Let a cashier receive a supplier order from POS by creating the existing canonical OS `Stock Receipt`, including safe partial receipts.
7. Preserve existing sale, fiscal, payment, shift and stock ledger semantics.

## Non-goals and invariants

- Do not change `TransactionEngine`, fiscal/payment providers, ATOL/INPAS behavior, receipt arithmetic or sale catalog semantics.
- Do not make hidden/non-assortment products sellable. Sale `products` remains point assortment only.
- Do not create a second schedule, purchase-order, receiving, stock-balance or write-off model.
- Schedule is read-only in POS. Editing remains in Raspechatka OS.
- Purchase orders are created/edited only in OS; POS only reads open orders and creates factual receipts.
- A POS receipt must never trust purchase price, supplier, warehouse, business entity or item identity from the renderer. The server derives these from the point-scoped submitted Purchase Order.
- Stock receipt/write-off delivery through POS must be retry-safe/idempotent.
- Cached older `workplace_data` without new fields must continue to load with empty defaults.
- POS-token scope must never expose or mutate another point.
- Existing SettingsHub admin-code gate remains the authority for “Настройки кассы”.

## Existing facts to reuse

### Windows POS

Active renderer is `pos/src/renderer/src/AppV2.tsx`.

`WorkPage` currently has tabs `Сегодня`, `Товары и склад`, `Поставки`, `Уборка`. Workplace data is synced through `raspechatka.api.pos_v2.get_bootstrap`, cached in `app_state.workplace_data`, and exposed through existing IPC.

Current write-off and point-need actions already use the POS outbox, but `raspechatka.api.pos_v2.push_events` does not currently consume `stock.write_off.requested` or `point.supply.requested`. DEV-159 must repair that end-to-end path.

The login selector already enforces numeric `maxLength=4`. `SettingsHub` intercepts clicks on `.settings-open-trigger` and applies the administrator-code gate, so the login screen should keep that class and only change presentation.

Electron Builder currently uses:
- `pos/build/icon.ico` for Windows executable/installer;
- `pos/build/icon.png` as packaged asset.

### Web OS

`frontend/index.html` has no favicon. Vite publishes into `raspechatka/public/frontend`; generated build output is not committed. Source favicon assets belong under `frontend/public` and the HTML should reference the deployed `/assets/raspechatka/frontend/...` path. Do not introduce a PWA/manifest solely for DEV-159.

### Schedule

Canonical models:
- `Work Schedule`
- `Work Schedule Entry`
- `Shift Template`

Web OS schedule is rendered in `frontend/src/pages/TeamPage.vue` as employees × days, using shift codes U/V and planned hours.

Current POS helper `_get_employee_schedule` is only one employee from today through +31 days. DEV-159 needs:
- full published schedule for the current point/current calendar month;
- separate five upcoming published shifts for the authenticated cashier, allowed to cross month boundaries.

### Warehouse

Canonical flow already exists:

`Purchase Order` → one or more submitted `Stock Receipt` documents.

`Purchase Order.update_received_quantities()` already sets:
- `Ожидается`
- `Частично принято`
- `Принято`

`Stock Receipt` already:
- validates point/entity/warehouse/supplier against the linked order;
- requires each line to reference its `Purchase Order Item`;
- prevents receiving more than the remaining ordered quantity;
- creates stock ledger entries;
- updates Purchase Order received quantities/status.

Therefore POS must not reproduce this logic.

## Target contracts

### Workplace schedule

Extend `WorkplaceData` with additive fields:

```ts
scheduleMonth: {
  month: string;
  days: number;
  employees: Array<{ id: string; name: string }>;
  entries: Array<{
    id: string;
    date: string;
    employeeId: string;
    shiftTemplate: string;
    shiftCode: string;
    shiftName: string;
    startTime: string;
    endTime: string;
    plannedHours: number;
  }>;
};

myUpcomingShifts: Array<{
  id: string;
  date: string;
  shiftTemplate: string;
  shiftCode: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  plannedHours: number;
}>;
```

Only `Work Schedule.status = Published` is visible. `myUpcomingShifts` is ordered by date/time, starts from the current/future planned schedule and is limited to 5; it may cross into future months.

Keep compatibility defaults for cached data. The old personal `schedule` field may remain temporarily for compatibility, but new renderer behavior must use the explicit new fields.

### Operational catalog

Do not widen the sale `products` array.

Add a separate `operationalCatalog` in `WorkplaceData` containing active catalog leaf items independently of `Catalog Assortment`. It must contain enough data for stock/need UI:

```ts
{
  id: string;
  name: string;
  itemCode: string;
  itemType: string;
  uom: string;
  trackInventory: boolean;
  stock: number | null;
  storageAddress: string;
}
```

The point warehouse, stock balance and storage address are server-derived. The stock table and write-off selector use inventory-tracked Product/Variant rows; Point Supply Request can select from the whole operational catalog. Parent templates that cannot be operationally transacted must not be offered as stock lines.

### Open purchase orders

Enrich the existing point-scoped delivery data; do not create a parallel purchase-order model.

For each submitted Purchase Order at the current point with status != `Принято`, return at least:

```ts
{
  id: string;
  supplier: string;
  expectedDate: string;
  status: string;
  deliveryCompany: string;
  deliveryCode: string;
  receivingNote: string;
  comment: string;
  items: Array<{
    purchaseOrderItemId: string;
    itemId: string;
    itemName: string;
    itemCode: string;
    uom: string;
    orderedQuantity: number;
    receivedQuantity: number;
    remainingQuantity: number;
  }>;
}
```

Only rows with positive remaining quantity are receivable.

### POS warehouse events

Existing actions:
- `stock.write_off.requested`
- `point.supply.requested`

New action:
- `stock.receipt.requested`

Every warehouse event must carry the authenticated employee id in its queued payload at creation time, so delayed synchronization still has trustworthy cashier attribution even after logout/no open shift.

For receipt, renderer/database queues only:

```ts
{
  cashierId: string;
  purchaseOrderId: string;
  lines: Array<{
    purchaseOrderItemId: string;
    quantity: number;
  }>;
}
```

The server:
1. authenticates POS token and resolves the trusted point employee;
2. verifies the Purchase Order belongs to the same point and is submitted/open;
3. loads Purchase Order Item rows itself;
4. derives item/uom/rate/supplier/entity/warehouse/storage from canonical server data;
5. validates requested quantities against remaining quantities;
6. creates and submits the normal `Stock Receipt` with `receipt_type = Приёмка`;
7. uses the POS event id as a unique external/source id so a retry cannot create a second receipt.

For write-off, use the same idempotent event-id principle and the existing `Stock Write Off` model. Do not use sale assortment to validate the product.

For Point Supply Request, keep the existing model and `source_pos_event` uniqueness.

### Employee attribution

A POS-created warehouse document must retain direct Employee attribution, not only a free-text remark. Add minimal optional Link fields where the canonical document lacks one:
- Stock Write Off: `cashier` → Employee
- Stock Receipt: `cashier` → Employee
- Point Supply Request: `requested_by_employee` → Employee

Keep existing `requested_by` User field for compatibility when an Employee has a linked User. Add `POS` to the existing `source` select for Stock Write Off / Stock Receipt and use it for POS-created documents; existing Manual/MoySklad behavior remains unchanged.

These DocType changes are schema changes applied by normal `bench migrate`; no data backfill is required.

## Renderer UX

### Branding and login

Windows icon:
- preserve current visible green artwork;
- remove the white pixels/background outside the rounded shape and make those corners transparent;
- regenerate both `icon.png` and `icon.ico` so the installed EXE/desktop/taskbar/installer uses the corrected alpha.

Web OS:
- derive favicon from the same corrected brand mark;
- add source favicon under `frontend/public`;
- add a favicon link to `frontend/index.html`;
- no new PWA manifest.

Cashier selection:
- normal selection screen has only `Выберите себя` as heading; remove `КТО РАБОТАЕТ?`;
- retain cashier cards;
- `Настройки кассы` remains `.settings-open-trigger`, visually a small link bottom-left.

PIN screen:
- show selected cashier + one real numeric/password input constrained to exactly 4 digits;
- visually communicate four positions/cells/dots without splitting into four independent inputs;
- normal existing-login flow has no big `Войти` button; Enter submits;
- PIN setup/admin-reset flows keep explicit action buttons because they are distinct confirmation flows;
- `Забыли PIN?` is a small link bottom-right;
- `Настройки кассы` is a small link bottom-left;
- auth, admin-code gate, PIN setup/reset rules stay unchanged.

### Toast and shift

- Global AppV2 message toast auto-dismisses after 3000 ms.
- Cross/manual close remains.
- Timer is cleaned up/restarted on message change so an old timer cannot close a newer message.
- Shift metric label only: `В кассе ожидается` → `Денег в кассе`.

### Work → График работы

Tabs after DEV-159:
- `График работы`
- `Товары и склад`
- `Уборка`

The schedule page contains only:
1. `Мои ближайшие 5 смен` — compact chronological list for active cashier, including date, weekday, shift name/code, time and planned hours where available.
2. A large read-only current-month point schedule grid, visually following Web OS: employee rows, day/weekday columns, U/V (or equivalent unambiguous shift mark), total planned hours.

No Save/edit controls, no point/month selector: point is current POS point and month is current month.

### Work → Товары и склад

Single page order:

1. Top two prominent actions:
   - `Списать брак`
   - `Потребность точки`

2. `Поставки` block:
   - table/cards for current point open Purchase Orders;
   - number, supplier, expected date, status, comment/receiving instruction;
   - expandable detail shows item + remaining qty;
   - `Создать приёмку` opens a compact modal;
   - modal is prefilled with remaining rows;
   - cashier can change quantity or remove a line;
   - no price editing/display required;
   - confirm queues canonical stock receipt;
   - full local receipt removes the order from the current local open list; partial local receipt reduces remaining quantities and leaves it visible until server sync replaces the snapshot.

3. Stock/storage table:
   - full point operational inventory catalog, not sale assortment;
   - columns: product, current stock, storage address;
   - search filters at least by name, catalog id and item code;
   - hidden-from-sale consumables remain visible if stock-tracked.

Do not keep a separate `Поставки` tab. The old “Уже отправлено закупщику” block is not part of this simplified page; backend compatibility data may remain.

Write-off modal vertical layout:
- Товар
- Количество
- Причина
- Комментарий

No two-column Quantity/Reason row. Selector uses full operational stock catalog, not sale assortment.

Point Supply modal selects from full operational catalog. Existing free-text fallback may remain if it does not weaken the catalog-first flow.

## Error/offline behavior

- Schedule/catalog/open Purchase Orders continue to be readable from the last cached `workplace_data` snapshot when offline.
- Write-off, point need and receipt use the existing durable outbox and may be queued offline.
- UI says the operation is queued/saved locally when server confirmation has not yet happened; it must not claim server receipt success before sync.
- Invalid/stale Purchase Order quantities are rejected server-side. On next bootstrap, canonical server state replaces optimistic local state.
- If an order was partially/fully received elsewhere while POS was offline, server validation prevents over-receipt and leaves the queued event unsent with a clear synchronization error; no duplicate stock movement is created.

## Focused tests required

Server tests must prove:
- current-point/current-month only published schedule grid;
- next five cashier shifts can cross month boundary;
- operational catalog is independent from Catalog Assortment and remains point-stock scoped;
- open Purchase Orders include lines/comments and exclude fully received orders;
- warehouse events cannot target another point;
- write-off and point need are actually accepted by `pos_v2.push_events`;
- receipt builds server-owned rate/item/supplier/warehouse from the Purchase Order;
- partial receipt keeps order partial; full receipt closes it;
- duplicate event id cannot create a second Stock Receipt/Write Off/Point Supply Request;
- cashier Employee attribution is written.

POS tests must prove:
- cached WorkplaceData normalizes missing new fields;
- queued warehouse events persist cashier id;
- schedule tab labels/5-shift limit/read-only contract;
- no separate Deliveries tab;
- operational catalog, not sale products, feeds stock/write-off/need UI;
- stock search filters by name/id/code;
- receive modal can reduce/remove rows and never sends a price;
- login normal flow has no submit button but Enter/form submit remains;
- toast timeout contract and shift label.

## Implementation parts

### DEV-159 (1) — Branding + cashier micro-UX

Correct Windows/Web icons; simplify login/PIN; 3-second toast; shift label. No business/data contracts.

### DEV-159 (2) — Read-only work schedule

Add scheduleMonth/myUpcomingShifts server contract, cache compatibility, and render the new Schedule tab.

### DEV-159 (3) — Safe warehouse data + event contracts

Add operational catalog, enriched Purchase Orders, Employee attribution schema, consume existing write-off/need events in pos_v2, add idempotent stock.receipt.requested server path and local queue primitives. No final WorkPage warehouse redesign yet.

### DEV-159 (4) — Unified Products & stock UI

Merge Deliveries into Products & stock; add receive modal, search, full operational catalog selectors, write-off layout fix and local optimistic remaining quantities. No server model changes beyond (3).

## Final verification after part (4)

Architect/reviewer runs once:
- relevant Python tests for POS/workplace/warehouse contracts;
- `pos/npm ci`, `npm run typecheck`, `npm test`, `npm run build`;
- `frontend/npm ci`, `npm test`, `npm run build`;
- `pos/npm run package:win` because Windows icon/installer changed;
- inspect packaged Windows icon and Web favicon visually;
- one PR to `version-16`;
- after merge, normal CI + Windows Installer + production deploy;
- manual POS smoke: login, toast, schedule, stock search, write-off/need queue, partial/full supplier receipt.
