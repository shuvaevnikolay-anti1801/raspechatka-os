# DEV-183 — Корректное удаление смены после отмены продаж и действий кассира

## Цель

Исправить жизненный цикл Admin Delete для `Sales Shift`.

Текущая проблема после DEV-181:

1. Admin удаляет `Sales Receipt`.
2. Удаление продажи корректно выполняется через `cancel()`, поэтому чек получает `docstatus=2` и исчезает из общего списка продаж.
3. Но карточка смены продолжает показывать этот чек в блоке «Продажи».
4. `Sales Shift` deletion handler продолжает считать отменённый чек зависимостью, потому что ищет все `Sales Receipt` по `shift` без фильтра `docstatus`.
5. Кроме того, `Cashier Action` (`SALE`, `CANCEL_RECEIPT`, `CASH_COUNT`, `OPEN_SHIFT` и др.) остаются в истории смены и часть из них блокирует удаление смены.
6. В результате Admin не может убрать старую ошибочную/зависшую смену даже после корректной отмены всех экономических документов.

База: `version-16` @ `5c1506eade23a10867d32d9f24e55b79b4394c9e`
Ветка: `codex/dev-183-shift-delete-lifecycle`

---

## Архитектурное правило

Нельзя решать проблему физическим удалением отменённых чеков, reversal-ledger или журнала аудита.

Нужно разделить:

- **активные экономические зависимости** — блокируют удаление;
- **отменённая/историческая трасса** — не должна блокировать удаление, но должна сохраняться;
- **полностью пустая ошибочная смена** — может hard-delete;
- **смена с историей, но без активного экономического эффекта** — должна архивироваться через `status = "Cancelled"`, а не удаляться физически.

В UI для Admin действие по-прежнему называется **«Удалить»**.

---

## 1. Исправить активные зависимости Sales Shift

В `raspechatka/deletion.py::_sales_shift`:

### Sales Receipt

Блокирующими являются только документы:

```python
{"shift": shift_name, "docstatus": ["!=", 2]}
```

То есть:

- draft (`docstatus=0`) — блокирует;
- submitted (`docstatus=1`) — блокирует;
- cancelled (`docstatus=2`) — НЕ блокирует.

### Cash Movement

То же правило:

```python
{"shift": shift_name, "docstatus": ["!=", 2]}
```

Отменённые движения денег сохраняются как история и не блокируют дальнейшее удаление смены.

### Preview

Если остаются активные документы, сообщение должно быть конкретным:

`Сначала удалите или отмените активные документы смены`

и показать отдельно counts/names:
- Sales Receipt;
- Cash Movement.

Не писать, что отменённый документ всё ещё требует действий.

---

## 2. Не считать Cashier Action самостоятельным блокером

`Cashier Action` — immutable audit/history.

Сам факт существования действий кассира не должен запрещать убрать смену после того, как все активные экономические документы обработаны.

Разделить действия на две категории.

### Технические shift-owned

Текущий whitelist сохраняется:

- `OPEN_SHIFT`
- `CLOSE_SHIFT`
- `CASH_COUNT`

и только если:
- `shift == Sales Shift.name`;
- `reference_doctype == "Sales Shift"`;
- `reference_document == Sales Shift.name`;
- совпадают business_entity/business_point.

Такие действия можно удалить только вместе с **реально пустой hard-delete сменой**.

### Исторические/business actions

Например:

- `SALE`
- `RETURN`
- `CANCEL_RECEIPT`
- `DEPOSIT`
- `WITHDRAWAL`
- `CANCEL_CASH_MOVEMENT`
- `DISCOUNT`
- `REVIEW_RECEIVED`
- `CLUB_REGISTRATION`
- `GIFT_ORDER`
- и прочие не-технические audit events.

Они:
- НЕ блокируют архивирование смены;
- НЕ удаляются;
- сохраняются как аудит.

Их наличие означает, что смену нельзя считать «никогда не использованной» для hard delete.

---

## 3. Две стратегии удаления смены

### A. hard_delete

Разрешён только если:

- нет активных Sales Receipt;
- нет активных Cash Movement;
- нет cancelled Sales Receipt;
- нет cancelled Cash Movement;
- нет business/history Cashier Action;
- есть максимум shift-owned technical actions.

Тогда:
1. удалить только доказанно shift-owned technical actions;
2. hard-delete `Sales Shift`;
3. создать External Event Suppression/tombstone для внешней POS/MoySklad смены;
4. записать Admin Deletion Audit.

Это сценарий «пустая ошибочная смена».

### B. archive

Если:
- активных Sales Receipt/Cash Movement уже нет;
- но есть cancelled документы и/или исторические Cashier Action;

то Admin Delete должен:

1. НЕ удалять Sales Shift физически;
2. установить `status = "Cancelled"`;
3. сохранить `closed_at` как есть; не придумывать ложное время закрытия;
4. сохранить cancelled receipts/cash movements;
5. сохранить все Cashier Action;
6. создать External Event Suppression/tombstone для внешней смены;
7. записать Admin Deletion Audit со strategy=`archive`;
8. вернуть success:
   `Смена убрана из работы; история сохранена.`

После этого смена:
- больше не считается открытой;
- не блокирует Employee POS access revoke;
- не входит в рабочую аналитику/overview;
- не может быть повторно открыта внешним replay.

---

## 4. Исправить карточку смены

Сейчас `get_shift()` делает:

```python
result["receipts"] = _receipt_rows({"shift": name})
```

из-за чего отменённая продажа остаётся в активном блоке «Продажи».

Исправить:

### Активные продажи

```python
result["receipts"] = _receipt_rows({
    "shift": name,
    "docstatus": ["!=", 2],
})
```

### Активные движения денег

Оставить/зафиксировать тот же принцип:
`docstatus != 2`.

### История отменённых документов

Не смешивать отменённые документы с активными.

Предпочтительно вернуть отдельные массивы:

- `cancelled_receipts`
- `cancelled_cash_movements`

и показывать их в отдельном сворачиваемом блоке:

**«Отменённые документы»**

Если frontend-реализация отдельного блока существенно увеличивает scope, минимум DEV-183:
- убрать cancelled docs из активных блоков;
- audit остаётся доступен через «Действия кассира».

---

## 5. Исправить список смен

Обычный список смен по умолчанию не должен показывать архивированные `status="Cancelled"`.

В `get_shifts()`:

- если `status` явно передан — использовать его;
- если status не передан — добавить:
  `status != "Cancelled"`.

При этом фильтр **Cancelled** должен оставаться доступным администратору/пользователю с соответствующим read-access для просмотра истории.

---

## 6. External replay safety

Критично сохранить DEV-181 suppression contract.

После Admin Delete смены, независимо от стратегии:

- `hard_delete`
- `archive`

если `source in {"POS", "MoySklad"}` и есть `external_id`:

создать/сохранить `External Event Suppression`.

POS/MoySklad replay не должен:
- создать смену заново;
- перевести архивированную смену обратно в Open;
- создать повторные документы.

Проверить, что текущий `delete_entity()` создаёт suppression и для `archive`, где `result["deleted"] = True`.

---

## 7. Employee access regression

Главный production-сценарий:

1. Employee имеет старую `Sales Shift(status="Open", source="POS")`.
2. В смене есть одна submitted sale.
3. Admin Delete sale:
   - sale -> docstatus=2;
   - reversal side effects выполнены;
   - sale исчезает из обычного списка.
4. Карточка shift после refresh:
   - active receipts пуст;
   - cancelled sale не отображается как активная;
   - Cashier Actions остаются в audit.
5. Admin Delete shift:
   - active dependencies = 0;
   - strategy = archive;
   - shift.status = Cancelled;
   - historical receipt/actions сохранены;
   - suppression создан.
6. Employee:
   - `pos_access_enabled` можно выключить;
   - проверка open shift больше не блокирует.

---

## 8. Тесты

Обязательные Frappe integration tests.

### Test 1 — exact production regression

Создать:
- open POS Sales Shift;
- submitted Sales Receipt;
- generated SALE Cashier Action.

Admin Delete receipt.

Проверить:
- Sales Receipt.docstatus == 2;
- shift totals пересчитаны;
- active receipt query смены не возвращает чек;
- общий sales list не возвращает чек.

Затем Admin Delete shift.

Проверить:
- strategy == `archive`;
- Sales Shift.status == `Cancelled`;
- cancelled Sales Receipt существует;
- SALE + CANCEL_RECEIPT actions существуют;
- External Event Suppression существует;
- open shift query не находит смену.

### Test 2 — cash movement

Submitted Cash Movement -> Admin Delete -> docstatus=2.

Shift Delete:
- не блокируется этим cancelled movement;
- archive сохраняет исторический Cashier Action.

### Test 3 — active dependency still blocks

Если Sales Receipt.docstatus == 1:
- shift preview = blocked;
- dependency содержит только активный receipt.

### Test 4 — truly empty shift

Open shift + only owned OPEN_SHIFT/CASH_COUNT:
- strategy hard_delete;
- technical actions удалены;
- shift удалена.

### Test 5 — standalone historical action

Shift без active docs, но с REVIEW_RECEIVED/DISCOUNT:
- strategy archive;
- action сохраняется.

### Test 6 — employee access

После archive old open shift:
- server больше не считает её open;
- Employee POS access можно revoke.

### Test 7 — replay

После archive:
- POS shift replay с тем же external_id -> ignored/suppressed;
- статус не возвращается в Open.

### Test 8 — list/detail API

- default get_shifts excludes Cancelled;
- explicit status=Cancelled returns archived shift;
- get_shift active receipts excludes docstatus=2.

---

## 9. Не делать

- не hard-delete cancelled Sales Receipt;
- не удалять reversal Stock Ledger Entry;
- не удалять Profitability history;
- не удалять Client Purchase history;
- не удалять business Cashier Action ради возможности убрать shift;
- не подменять closed_at текущим временем;
- не bypass suppression;
- не ослаблять Admin/scope checks DEV-181.

---

## Acceptance

DEV готов, когда реальный пользовательский сценарий работает так:

`Продажа → Удалить`

Продажа исчезает из рабочего списка и из активного блока смены.

Затем:

`Смена → Удалить`

Если других активных документов нет:
- ошибка про уже отменённую продажу больше не появляется;
- ошибки из-за audit Cashier Action больше нет;
- смена исчезает из обычного списка;
- история остаётся доступной как Cancelled;
- сотруднику можно отключить POS-доступ.
