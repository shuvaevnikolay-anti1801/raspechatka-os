# DEV-178 — Windows POS: рабочая полировка, заказы, sync-admin и безопасный KKT recovery

## Цель

Объединить PLAN-068…073 в один релизный DEV без создания параллельных моделей и очередей.

Ветка: `codex/dev-178-pos-ux-recovery`  
База исследования: `version-16` @ `3362698efe1bccd45a051e4ee247b7238c6fd5fd`.

DEV состоит из 5 последовательных частей в одной ветке. После каждой части — focused tests. Полный CI/build/package/PR выполняет архитектор после последней части.

## Обязательные правила

Перед каждой частью читать `AGENTS.md`, `pos/AGENTS.md` и только относящиеся к части файлы. Для части 4 обязательно прочитать `pos/DEV-151-ATOL-DRIVER.md`.

Не:
- создавать вторую sync-queue, вторую transaction journal или отдельную модель заказа рядом с существующей;
- делать blind retry для payment/fiscal UNKNOWN;
- смешивать outbox sync с `TransactionJournal` recovery;
- менять `version-16` напрямую;
- превращать временно недоступную ККТ в обычную «отложенную фискализацию».

---

## Исследование текущего кода

### PLAN-068 — повторные рекомендации допродажи

`pos/src/renderer/src/AppV2.tsx`:
- `upsellCycle` стартует в `eligible`;
- `add()` показывает рекомендацию только если `upsellCycle.state === 'eligible'`;
- `dismissUpsell()` и `acceptUpsell()` переводят цикл в `resolved`;
- после этого до очистки чека новый вручную добавленный товар уже не может открыть следующую рекомендацию;
- accepted target добавляется через `add(target,{suppressUpsell:true})`, что уже предотвращает цепочку recommendation → recommendation.

`pos/src/shared/upsell.ts`:
- состояния `eligible | showing | resolved`;
- удаление trigger-позиции из корзины сейчас также переводит showing → resolved.

Нужна не очередь рекомендаций, а повторно используемый один слот: после завершения/утраты актуальности текущего предложения слот снова `eligible`. Пока `showing`, новые triggers игнорируются и не накапливаются.

### PLAN-069 — убрать красную «Убрать» у покупателя

`pos/src/renderer/src/CurrentReceipt.tsx` рисует `.receipt-service-remove` рядом с выбранным покупателем и получает `onRemoveCustomer`.

`AppV2.tsx` передаёт `onRemoveCustomer={()=>chooseCustomer(null)}`.

При этом `CustomerModal` уже содержит вариант «Розничный покупатель», поэтому отдельная красная ссылка действительно дублирует существующий сценарий. Удалить только этот control/prop/dead CSS, не менять customer state/discount semantics.

### PLAN-070 — таблица заказов

`pos/src/renderer/src/OrdersPage.tsx` сейчас имеет колонки:
`status, orderNumber, phone, contactMethod, description, payment, createdAt, dueAt, issuedAt, actions`.

`issuedAt` подписан «Выдан», хотя рабочий список уже фильтрует active statuses, и выданный заказ из него исчезает.

`pos/src/renderer/src/orders-table.css`:
- header/row: `width:max-content; min-width:100%`;
- description/contact clamp до 2 строк;
- это создаёт постоянный horizontal overflow и обрезает описание.

Критичный факт исследования номера:
- в актуальном `version-16` отдельного пользовательского номера заказа по телефону нет;
- `pos/src/main/database.ts` в `createOrderFromSale()` и `createUnpaidOrder()` генерирует `orderNumber = ORD-YYYYMMDD-<uuid6>`;
- server `POS Order.order_number` получает именно его;
- backend update ищет заказ по `order_number + business_point`.

Поэтому НЕЛЬЗЯ просто заменить существующий `orderNumber` у старых/queued заказов: он уже используется как integration lookup key. Нужен additive пользовательский идентификатор, например `customerOrderNumber`, при сохранении текущего `orderNumber` как технического sync identity.

Правило `customerOrderNumber`:
- база = последние 4 цифры нормализованного телефона;
- при совпадении среди активных заказов точки: `1234`, `1234 (1)`, `1234 (2)`…;
- после присвоения номер конкретного заказа не меняется;
- legacy active orders получают deterministic backfill по `createdAt + technical id`;
- Orders UI и сообщение «Заказ … принят» показывают customer number, technical `orderNumber` пользователю не показывается.

Реализация additive:
- shared `Order`: `customerOrderNumber?: string` на переходный период;
- SQLite orders: additive column `customer_order_number`;
- allocator рядом с order persistence в `database.ts`, используя существующий `normalizeRussianPhone`;
- POS Order DocType: additive read-only field `customer_order_number`;
- POS ingest/bootstrap прокидывают поле;
- миграция/backfill existing active POS Orders и existing local SQLite rows;
- никаких destructive rename existing `order_number`.

UI:
- убрать `issuedAt` column только из Windows table;
- сохранить issuedAt/status в данных;
- обычная ширина окна (app minWidth сейчас 1100) должна помещать таблицу без horizontal scroll;
- column resize сохраняется, но grid widths должны быть weights/flexible within container rather than unconditional summed px;
- очень узкий fallback может иметь horizontal overflow;
- description: no line-clamp/ellipsis, `white-space:normal`, row auto-height.

### PLAN-071 — админ управление sync queue

DEV-177 уже дал:
- outbox v2 attempts/backoff/problem;
- `SettingsSyncQueue`;
- `retrySyncEvent`;
- safe event policy.

Но текущий retry не является строго single-event:
`pos/src/main/ipc.ts -> pos:retry-sync-event` вызывает общий `performSync()`, который отправляет все due events batch-ами.

Есть неиспользуемый `pos/src/main/outbox-admin-ipc.ts` с break-glass discard, но он не зарегистрирован в `index.ts` и не доступен preload/UI. Не подключать его вслепую как отдельную вторую систему; либо удалить/заменить, либо использовать идеи внутри основного sync IPC.

Цель:
- «Отправить сейчас» делает attempt только выбранного outbox event с тем же immutable ID/payload;
- успешный accepted → terminal/sent, строка исчезает;
- reject/transport → остаётся и сразу показывает updated attemptCount/lastAttemptAt/lastError/status;
- admin может «Удалить из очереди» допустимый event с подтверждением и audit diagnostic.

Manual actions должны сериализоваться с automatic sync: если event уже участвует в in-flight sync, сначала дождаться результата, затем принимать решение. Нельзя обещать «удалено», если сервер мог уже принять событие.

Protected classes, которые нельзя generic discard:
`shift.opened, shift.closed, sale.completed, sale.returned, cash.deposited, cash.withdrawn, cash.counted`.
Payment/fiscal UNKNOWN вообще живут не в outbox, а в TransactionJournal и остаются только в recovery.

Для прочих owner-domain sync events admin discard допустим как осознанный отказ от server delivery после явного confirmation. Локальный business document не удалять. Сохранить audit diagnostic с event id/type/time.

Не помечать discard как «успешно отправлено». Добавить отдельную terminal semantics (`discarded`/discardedAt либо эквивалент), а queue counts должны считать только pending/problem.

### PLAN-072 — ККТ недоступна, а «Незавершённых операций» = 0

Причина найдена в `pos/src/main/ipc.ts`:
- `pos:complete-sale` делает `fiscalProvider.healthCheck()` и `assertFiscalShiftReady()` ДО `transactionEngine.completeSale()`;
- если ККТ отключена, запрос падает до создания записи в `TransactionJournal`;
- поэтому Settings корректно показывает 0 unresolved.

`PosTransactionEngine` уже умеет:
- persist operation до опасных внешних действий;
- persist payment/fiscal attempts;
- UNKNOWN → reconcile before repeat;
- если pre-fiscal snapshot не получен, external fiscal call не делается, а operation остаётся recoverable.

Нужно перенести fiscal preflight внутрь TransactionEngine после durable create, но ДО денежных side effects:
1. pure validation остаётся до journal;
2. operation создаётся;
3. KKT health + fiscal shift readiness выполняются внутри engine;
4. если ККТ точно не ready / shift unavailable ДО payment/fiscal I/O:
   - operation остаётся видимой в recovery с human-safe reason;
   - никакой terminal/acquiring charge и никакой fiscal call не выполняются;
   - recovery после восстановления ККТ продолжает ту же operation;
   - должна быть безопасная отмена только для операции, для которой доказано отсутствие payment/fiscal attempts/confirmed payment.
5. если внешняя fiscal команда уже стартовала и результат UNKNOWN — только существующий reconcile, без повторной fiscalization.
6. аналогичную preflight boundary применить к return, чтобы не оставить тот же класс дефекта на возврате.

### Нормативное решение по «принять наличные сейчас, пробить позже»

На 24.09.2026 обычный режим deferred fiscalization НЕ закладываем.

Основания:
- п.1 ст.4.3 54-ФЗ: при непосредственном взаимодействии ККТ применяется в момент взаимодействия при осуществлении расчёта;
  https://www.consultant.ru/document/cons_doc_LAW_42359/c66f699f7114b0ac2d3309283162539ad93ea8d1/
- ФНС 25.02.2026 также указывает: ККТ применяется на месте расчёта в момент расчёта;
  https://www.nalog.gov.ru/rn59/news/activities_fts/16605068/
- ФНС в актуальных разъяснениях по неприменению ККТ рассматривает совершённый без ККТ расчёт как нарушение/ошибку, исправляемую чеком коррекции, в том числе при техническом сбое;
  https://www.nalog.gov.ru/rn63/news/activities_fts/16633583/
  https://www.nalog.gov.ru/rn25/news/activities_fts/15627673/

Следствие для DEV-178:
- обычная продажа НЕ становится completed, cash balance НЕ увеличивается как завершённая продажа, `sale.completed` в OS outbox НЕ создаётся, пока нет подтверждённой фискализации;
- отключённая ККТ должна давать durable unresolved operation вместо исчезающей ошибки;
- отдельный emergency workflow «расчёт уже фактически принят без ККТ → чек коррекции» — отдельная будущая задача с юридическими реквизитами/ФФД и не должна быть имитацией обычного sale retry.

### PLAN-073 — отложенные чеки

`ReceiptsPage.tsx` сейчас:
- card head показывает label + время/количество позиций + сумму;
- показывает 4 lines, затем `+ ещё N`;
- Continue стоит внизу.

`styles.css`:
- `.held-receipts { max-height:180px; overflow:auto; }`;
- grid `repeat(auto-fill,minmax(270px,1fr))`;
- card `min-height:150px; grid-template-rows:auto 1fr auto`.

Нужно:
- one-row horizontal strip;
- `overflow-x:auto; overflow-y:hidden`;
- fixed/flexible card width, no internal vertical scroll;
- head left: `customer?.name || 'Розничный'`, under it total;
- compact Continue top-right;
- no date/time/count metadata;
- up to 5 lines + `+ ещё N` if >5;
- hold/restore data/lifecycle untouched.

---

# Части

## 1. Sale receipt: reusable upsell slot + customer control cleanup
PLAN-068, PLAN-069.

Files:
- `pos/src/renderer/src/AppV2.tsx`
- `pos/src/renderer/src/CurrentReceipt.tsx`
- `pos/src/shared/upsell.ts`
- `pos/src/renderer/src/sale-workspace.css`
- `pos/src/shared/upsell.test.ts`
- `pos/src/renderer/src/AppV2.contract.test.tsx`
- focused CurrentReceipt tests if present/needed.

Acceptance:
- A trigger → proposal shows.
- while showing, B trigger added → no replace/no queue.
- accept/dismiss/remove-trigger frees slot.
- later manually add C trigger → C proposal shows.
- accepted upsell target uses `suppressUpsell:true` and cannot chain.
- hold/restore never resurrects accepted/dismissed candidate.
- separate red «Убрать» absent; customer button still opens modal and «Розничный покупатель» removes customer.

## 2. Orders: stable customer number + responsive readable table
PLAN-070.

Files:
- `pos/src/shared/contracts.ts`
- `pos/src/main/database.ts`
- `pos/src/renderer/src/OrdersPage.tsx`
- `pos/src/renderer/src/orders-table.css`
- `pos/src/renderer/src/AppV2.tsx` (order success message only)
- `raspechatka/raspechatka_os/doctype/pos_order/pos_order.json`
- `raspechatka/api/pos.py`
- current POS v2 bootstrap/serialization path in `raspechatka/api/pos_v2.py` / `pos_device.py` as actually used
- additive patch/backfill if needed
- `pos/src/main/order-update.test.ts`
- `pos/src/renderer/src/orders-table.test.tsx`
- `raspechatka/tests/test_pos_orders.py`.

Acceptance:
- technical integration `orderNumber` remains immutable and sync-compatible;
- user-visible `customerOrderNumber` follows last4 + suffix and is stable;
- old active orders get deterministic human number;
- no «Выдан» column, but issued state/data still works;
- standard app width has no horizontal scroll;
- narrow fallback remains usable;
- description fully wraps, row grows;
- resize changes proportions/content wrapping without clipping description.

## 3. Sync queue: exact retry + audited admin discard
PLAN-071, builds on DEV-177.

Files:
- `pos/src/main/sync.ts`
- `pos/src/main/ipc.ts`
- `pos/src/main/database.ts`
- `pos/src/main/sync-queue-policy.ts`
- `pos/src/main/outbox-admin-ipc.ts` (remove/deprecate or fold in; no duplicate handler layer)
- `pos/src/shared/contracts.ts`
- `pos/src/preload/index.ts`
- `pos/src/renderer/src/SettingsHub.tsx`
- `pos/src/renderer/src/settings-hub.css`
- sync/database/settings tests.

Acceptance:
- manual retry attempts only selected event;
- result visible immediately;
- problem owner-domain event can be retried only where policy says safe;
- discard requires admin+confirmation, is race-safe with automatic sync, creates audit record;
- protected financial/cash/shift events have no generic discard;
- unresolved payment/fiscal operations remain separate;
- discarded is not reported as sent.

## 4. KKT preflight becomes durable recovery instead of disappearing error
PLAN-072, builds on DEV-151/177.

Files:
- `pos/src/main/ipc.ts`
- `pos/src/main/transaction-engine.ts`
- `pos/src/main/transaction-journal.ts` only if state/cancel metadata is needed
- `pos/src/shared/contracts.ts`
- `pos/src/preload/index.ts`
- `pos/src/renderer/src/SettingsHub.tsx` only for safe cancel/recovery UX
- `pos/src/main/transaction-engine.test.ts`
- focused IPC/recovery tests.

Acceptance:
- disconnected/unconfigured KKT after valid sale intent creates unresolved operation;
- zero payment-provider calls and zero fiscal calls occur when fiscal readiness is known false before side effects;
- Settings shows amount/method/time/reason and «Проверить и продолжить»;
- restart/lock/cashier switch preserve operation;
- after KKT ready, recover same clientRequestId once;
- pre-side-effect operation can be explicitly cancelled safely; UNKNOWN cannot;
- fiscal timeout after call remains UNKNOWN and never blind retries;
- no sale row, cash shift total, order-from-sale or `sale.completed` outbox event until fiscalization is proven;
- no general «cash now / ordinary fiscal receipt later» mode.

Hardware acceptance after automated tests:
- real ATOL disconnected before sale;
- reconnect same serial and recover;
- USB loss after fiscal call boundary;
- prove no duplicate fiscal receipt.

## 5. Held receipts horizontal compact strip + final regression
PLAN-073 + integration sweep.

Files:
- `pos/src/renderer/src/ReceiptsPage.tsx`
- `pos/src/renderer/src/styles.css`
- `pos/src/renderer/src/receipt-ux.test.ts`
- DEV-178 changed files only for final focused regressions.

Acceptance:
- held cards are one horizontal strip;
- only horizontal overflow of strip when needed;
- no vertical scrollbar in held section/card;
- buyer/Розничный + total left, compact Continue right;
- max 5 product lines + `+ ещё N`;
- date/time/item-count removed from held card;
- hold/restore/upsell snapshot behavior unchanged.

Final automated gate (architect after part 5):
```
cd pos
npm ci
npm run typecheck
npm test
npm run build
```
If backend changed, run focused Frappe tests for POS orders and relevant access checks. Windows `package:win`/physical ATOL acceptance is separate from unit CI.

## Definition of done

All PLAN-068…073 acceptance cases pass on one DEV branch. No unsafe fiscal deferred mode is introduced. User-facing order number is no longer the technical integration number. Sync admin actions operate on exact events and remain separate from payment/fiscal recovery. UI refinements do not regress existing held receipt, discount, order, outbox or transaction safety contracts.
