# DEV-181 — Единый безопасный Admin Delete / Cancel / Archive

## Цель

Дать пользователю с уровнем доступа **Admin** на соответствующей странице единое действие **«Удалить»** для сущностей Raspechatka OS, при этом backend обязан сохранять целостность системы и самостоятельно выбирать безопасную стратегию:

- hard delete — только для действительно безопасных черновиков/неиспользуемых сущностей;
- cancel/reversal — для проведённых операционных документов, которые изменяют склад, деньги, продажи, клиента, смену и другие регистры;
- archive/deactivate — для мастер-данных и исторических сущностей, удаление которых разрушило бы ссылки/аудит;
- blocked — если корректная обратная операция пока не реализована или есть несовместимые зависимости.

Пользователь Admin не должен разбираться во внутреннем Frappe docstatus. В UI действие называется одинаково — **«Удалить»**. Доменная стратегия определяется сервером.

База: `version-16` @ `8c14e5c4c452050fc4fc4980d3058f11f008f72a`
Ветка: `codex/dev-181-admin-safe-delete`

---

## Существующая модель доступа

`raspechatka/access.py`:
- None = 0
- View = 1
- Edit = 2
- Admin = 3
- action `delete` и `admin` требуют уровня 3.

Это единственная permission authority для Web OS. Не создавать отдельную роль «может удалять».

Кнопка Delete показывается только если frontend `canAccess(page_area, "Admin")` / эквивалентное permission API подтверждает Admin. Backend всегда повторно проверяет `require_access(area, "delete")`.

---

## Главное архитектурное правило

**Никогда не использовать generic frappe.delete_doc() напрямую для проведённого бизнес-документа, если его создание создало производные эффекты.**

Удаление должно быть доменным сервисом с registry стратегий.

Предлагаемый сервис:
`raspechatka/deletion.py`

Public contract:
`delete_entity(entity_type, name, reason=None)`

Результат:
- `strategy: hard_delete | cancel | deactivate | archive | blocked`
- `deleted: bool`
- `message`
- `affected[]` — какие производные сущности были отменены/пересчитаны
- `warnings[]`

Все действия выполняются одной DB transaction. При любой ошибке — полный rollback.

Каждый delete пишет immutable Audit Log / Error Log-compatible admin diagnostic минимум:
- user
- entity_type
- entity_name
- strategy
- timestamp
- reason
- affected references
- outcome

Не делать silent cascade без audit.

---

## Матрица стратегий v1

### Операционные документы — cancel/reversal

#### Sales Receipt
Проведённый чек нельзя hard-delete.
Delete -> `doc.cancel()`.

Уже существующий `on_cancel()`:
- reverse stock ledger entries;
- reverse profitability;
- update/cancel Client Purchase state;
- recalculate Sales Shift;
- log CANCEL_RECEIPT.

После cancel документ остаётся как audit/history (docstatus=2).
Физическое удаление отменённого Sales Receipt в DEV-181 НЕ требуется.

Если это Sale и существуют проведённые Return на неё — блокировать до отмены/удаления возвратов либо реализовать безопасный ordered cascade только если тестами доказана корректность. Предпочтение v1: explicit block с понятным списком зависимостей.

#### Cash Movement
Delete -> `cancel()`.
Existing on_cancel:
- recalc shift;
- audit action;
- cancel linked Finance Transaction.

#### Stock Receipt
Delete -> `cancel()`.
Existing on_cancel:
- reversal Stock Ledger Entry;
- update Purchase Order received quantities.

#### Stock Write Off
Delete -> `cancel()`.
Existing on_cancel:
- reversal stock ledger.

#### Stock Inventory
Delete -> `cancel()`.
Existing on_cancel:
- reversal difference movements.

#### Purchase Order
Draft -> hard delete if no dependent docs.
Submitted -> cancel if domain rules allow.
Existing payment allocations / stock receipts must block with explicit dependencies; Admin does not bypass integrity.

### Sales Shift

Sales Shift currently is not submittable and has no complete on_cancel/on_trash domain rollback.

DEV-181 strategy:
1. If shift has **no** Sales Receipt, Cash Movement or non-technical Cashier Action dependencies:
   - hard delete allowed for Admin.
   - remove shift-owned technical OPEN_SHIFT/CLOSE_SHIFT/CASH_COUNT actions tied only to that shift as part of same transaction.
2. If shift has dependent business documents:
   - v1 must NOT hard delete.
   - return blocked with exact dependency counts and links/ids.
   - future cascade may be separate DEV after explicit contract.

This specifically allows cleanup of orphan/stale POS shifts that block Employee POS access.

### Employee

Employee with no business history/dependencies:
- hard delete allowed.

Employee referenced by shifts, receipts, payroll, schedule, motivation, leave, documents, etc.:
- no hard delete.
- Admin Delete performs **deactivate/archive semantics**:
  - active=0;
  - pos_access_enabled=0 if no open POS shift;
  - preserve historical links.
- If an open POS shift exists, block until shift is deleted/closed.
- system_user_profile / Web User is NOT silently destroyed; access can be disabled separately. Return warning if linked profile exists.

### Business Point

Never hard delete a point with any operational/history documents.

Fresh/unused point:
- hard delete only if dependency probe proves safe;
- cleanup auto-created infrastructure in same transaction:
  - Catalog Warehouse
  - POS Workplace
  - Cash Register
  - POS Connection if no events/history
  - point-owned empty configuration rows explicitly registered.

Used point:
- Admin Delete -> deactivate:
  - Business Point.active=0
  - auto-created warehouse/workplace/register disabled, not deleted
  - historical data remains.

### Catalog Warehouse / Cash Register / POS Workplace / Business Entity / Organization / Catalog Item / Client / Supplier and other master data

Default strategy: deactivate/archive if referenced.
Hard delete only when dependency probe shows zero references and registry explicitly allows it.

No generic hard-delete fallback for unknown DocType.

Unknown/unregistered entity -> blocked: `Для этого типа сущности безопасное удаление ещё не реализовано`.

---

## UX contract

Reusable component/action, not page-specific ad hoc buttons.

For list/card/detail views:
- if current page access < Admin: no Delete control;
- if Admin: show red **«Удалить»** action.

User asked for direct Admin action without unnecessary friction. Still use one concise confirmation only for destructive operations with side effects:
- title: `Удалить <entity label>?`
- server preview can state chosen strategy and consequences.
- For trivial draft hard-delete confirmation may be skipped if current design standard permits.
- Never require typing entity name or multi-step ceremony.

If strategy is deactivate/archive, UI may still label main action «Удалить», but completion toast explicitly says:
`Объект деактивирован; история сохранена.`

If blocked:
show exact dependencies, e.g.
`Смену нельзя удалить: 3 продажи, 1 возврат, 2 движения наличных. Сначала удалите зависимые документы.`

---

## Preview endpoint

Before destructive action, optional but recommended:
`get_delete_preview(entity_type, name)`

It must use the same registry/resolver as execution so UI cannot promise a strategy backend rejects.

Return:
- strategy
- dependency counts
- consequence summary
- can_delete
- warnings

Do not rely on frontend for safety.

---

# DEV-181 (1) — Deletion service + registry + audit + permissions

Create central deletion domain service.

Tasks:
1. registry maps supported entity type -> page access area -> scope resolver -> strategy handler.
2. enforce `require_access(area, "delete")`.
3. enforce point/entity scope on every object.
4. transaction/rollback.
5. dependency probe utilities.
6. immutable admin audit record/diagnostic.
7. preview + execute APIs with access_contract.
8. unknown type fail closed.
9. tests for View/Edit/Admin and cross-scope delete denial.

No UI yet.

---

# DEV-181 (2) — Financial/stock/sales operational documents

Implement registry strategies for:
- Sales Receipt
- Cash Movement
- Stock Receipt
- Stock Write Off
- Stock Inventory
- Purchase Order

Rules:
- submitted operational docs use cancel/reversal;
- drafts may hard delete where safe;
- dependency checks prevent invalid cascade;
- verify Stock Balance after receipt/write-off/inventory cancel;
- verify Profitability, Client Purchase, Sales Shift totals after Sales Receipt cancel;
- verify Finance Transaction after Cash Movement cancel;
- verify Purchase Order received quantities after Stock Receipt cancel.

Critical tests assert balances before create, after submit, after Admin Delete.

---

# DEV-181 (3) — Sales Shift cleanup + Employee safe removal

Implement:
### Sales Shift
- empty/orphan shift can hard delete;
- remove only shift-owned technical actions;
- with receipts/cash movements -> blocked with counts;
- source POS/MoySklad/Manual/Import uses same integrity rule;
- deleting stale empty POS shift unblocks Employee pos_access revoke.

### Employee
- unused employee hard delete;
- referenced employee -> deactivate/archive;
- no destruction of history;
- open POS shift blocks deactivation;
- linked Web OS profile is preserved and warning returned.

Tests include the exact production bug scenario:
old empty `source=POS,status=Open` shift -> Admin deletes shift -> Employee POS access checkbox can be disabled successfully.

---

# DEV-181 (4) — Master data + shared Admin Delete UX

Implement safe strategies for currently user-manageable master data/pages, starting with:
- Business Point
- Catalog Warehouse
- Cash Register
- POS Workplace
- Catalog Item
- Catalog Supplier
- Client
- Business Entity / Organization where exposed
- other first-party entities reachable from current UI.

Do not pretend every Frappe DocType should be deletable. Registry contains business entities exposed by Raspechatka OS.

Business Point:
- fresh unused -> safe infrastructure cleanup;
- used -> deactivate point + warehouse/workplace/register;
- no historical cascade.

Add reusable frontend Admin Delete control:
- visible only at Admin;
- preview consequence;
- execute;
- refresh list/detail after success;
- consistent error/dependency display.

Apply first to:
- Sales → Shifts/Receipts/Cash
- Warehouse document screens
- Employees
- Business Points
then expand to registry-backed current entity cards/lists where practical in same DEV.

---

## Security / correctness requirements

1. Admin means permission to request deletion, NOT permission to violate database integrity.
2. Scope rules remain mandatory even for Admin role unless user scope itself is Network/global.
3. No raw client-supplied doctype allowed. Use server registry enum.
4. No SQL delete from frontend parameters.
5. No generic child cascade.
6. All operational reversal paths must be idempotent against retries.
7. A failed delete leaves original and all ledgers unchanged.
8. Historical accounting/stock audit should remain reconstructable.
9. Imported MoySklad mirror receipts: cancel/delete must not create stock reversal because `mirror_only=1`; shift totals still recalc.
10. POS sync retries after an Admin-cancelled/deleted source event must not silently recreate invalid documents. For documents with stable POS external_id, add tombstone/terminal external-event protection where necessary.

### Tombstone requirement

This is critical for POS/MoySklad external documents:
If Admin removes/cancels a document that can later be replayed from an external source, the next sync must not silently recreate it.

Implement a durable deletion tombstone / External Event Suppression record for external_id + source, or another equally safe mechanism.

Minimum:
- Admin delete/cancel of POS/MoySklad document records suppression;
- ingest checks suppression before upsert/create;
- explicit Admin restore/re-import is out of scope;
- tombstone is auditable.

Without this, DEV is not complete.

---

## Non-goals

- no arbitrary SQL/database console;
- no bypassing foreign keys;
- no wiping historical accounting chains;
- no generic cascade of all dependencies;
- no permission model rewrite;
- no physical deletion of audit logs/tombstones;
- no delete access for Edit users.

---

## Final acceptance matrix

Must prove at minimum:

1. Edit user cannot see/call delete.
2. Admin sees action and backend accepts only in own scope.
3. Empty stale POS Sales Shift can be removed.
4. Shift with receipt is blocked with dependency explanation.
5. Stock Receipt +10 -> Admin Delete -> effective stock returns exactly to previous quantity/value.
6. Stock Write Off -> delete -> stock restored.
7. Inventory adjustment -> delete -> balance restored.
8. POS Sale -> delete/cancel -> stock/profit/client/shift totals restored.
9. Cash Movement collection -> linked Finance Transaction cancelled.
10. MoySklad mirror receipt delete/cancel does not touch physical stock.
11. Employee with history becomes inactive, history remains.
12. Fresh unused Employee can be hard deleted.
13. Used Business Point is deactivated, history remains.
14. Fresh Business Point can be removed with empty generated infrastructure safely.
15. external POS/MoySklad event does not resurrect after Admin removal due to tombstone.
16. delete endpoint is fail-closed for unregistered entity types.

Final report must contain a table of every registered entity and its strategy:
hard_delete / cancel / deactivate / blocked + dependencies + reversal effects.
