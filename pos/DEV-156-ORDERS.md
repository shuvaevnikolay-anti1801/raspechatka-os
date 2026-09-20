# DEV-156 — Рабочий модуль «Заказы»

## Цель

Довести уже существующий контур POS Order до простого рабочего инструмента кассира и наблюдаемого списка для администрации.

Это не CRM и не новый денежный контур. Существующие sale/payment/fiscal flows остаются источником факта оплаты. Заказ только описывает оплачиваемую/оплаченную работу, её срок и жизненный цикл.

## Текущее основание

В stable уже есть:
- локальная SQLite-таблица `orders`;
- `Order`, `OrderStatus`, `CreateUnpaidOrderRequest`, `UpdateOrderRequest`;
- создание заказа вместе с успешно завершённой продажей через `CompleteSaleRequest.order`;
- связь `sourceSaleId` + `fiscalNumber`;
- outbox `order.created` / `order.updated`;
- server DocType `POS Order` и `POS Order Item`;
- приём order events в Frappe;
- server -> POS bootstrap orders и `replaceServerOrders`;
- POS header badge и текущий OrdersPage.

Не создавать параллельную сущность.

## Бизнес-модель

### Номер заказа

Внутренний `orderNumber` остаётся уникальным техническим идентификатором и не заменяется четырьмя цифрами.

Кассиру и администратору показывать короткий номер заказа = последние 4 цифры нормализованного телефона. Пример: `+7 920 123-45-67` → `№ 4567`.

Совпадение коротких номеров допустимо: строка всегда содержит полный телефон, время и точку. Не вводить unique constraint на 4 цифры.

### Обязательные данные нового заказа

Для нового заказа обязательны:
- телефон;
- описание работы (существующий `comment`, в UI называется «Описание заказа»);
- срок готовности `dueAt`;
- привязка к оплаченной продаже/чеку.

Заказ, который создаётся из текущей продажи, получает связь с этой продажей автоматически после успешной оплаты и фискализации.

Отдельное создание из раздела «Заказы» возможно только через выбор уже оплаченного чека текущей точки. Нельзя создавать новую неоплаченную производственную задачу без чека.

### Статусы

Сохраняем существующий enum для совместимости:
- `new`;
- `in_progress`;
- `ready`;
- `issued`;
- `cancelled`.

Новый рабочий заказ создаётся сразу как `in_progress`.

Legacy `new` в POS трактуется как «В работе» и остаётся поддержанным без массовой миграции.

Обычный кассир работает только с двумя переходами:
1. `new|in_progress -> ready` кнопкой «Готово»;
2. `ready -> issued` большой кнопкой «Выдан».

Свободный status select из основного POS UX убрать. `cancelled` сохраняется как технический legacy status, но не становится обычной кнопкой рабочего процесса.

После `issued` заказ исчезает из рабочего списка POS, но остаётся в истории на сервере.

## Временные события и аналитика

Нужно хранить и передавать:
- `createdAt` — уже существующее время создания;
- `dueAt` — обязательный срок готовности;
- `readyAt` — первый момент перехода в `ready`;
- `issuedAt` — первый момент перехода в `issued`.

Правила:
- `readyAt` выставляется атомарно при первом переходе в `ready`; повторное сохранение `ready` его не переписывает;
- `issuedAt` выставляется атомарно при первом переходе в `issued`; повторное сохранение `issued` его не переписывает;
- возврат статуса назад не стирает исторические timestamps;
- server DocType хранит `ready_at` и `issued_at`; SQLite — `ready_at`, `issued_at`;
- старые заказы без этих полей остаются валидны.

Для Web OS вычислять/показывать:
- время выполнения = `readyAt - createdAt`, если readyAt есть;
- просрочка: активный заказ с `now > dueAt` и без readyAt либо `readyAt > dueAt`;
- время ожидания выдачи = `issuedAt - readyAt`, если оба есть.

Это даёт основу для дальнейшей CRM/SLA-аналитики без отдельной аналитической таблицы.

## Связь с чеком

### Заказ из текущей продажи

Сохранить существующий безопасный поток:
`PaymentModal -> TransactionEngine.completeSale -> fiscalized -> database.saveSale -> create order`.

Не создавать заказ до успешного завершения sale operation.

Не менять payment, fiscalization, recovery или TransactionJournal semantics.

### Отдельное создание из «Заказов»

Кнопка `+ Создать заказ`.

Диалог:
1. выбрать оплаченный чек текущей точки;
2. телефон;
3. описание заказа;
4. срок готовности;
5. создать.

Чек можно искать по номеру/телефону/покупателю. Использовать существующие local sales + point-scoped receipt mirror/search; не вводить новый денежный запрос.

Main-process обязан проверить, что выбранный receipt snapshot относится к текущей точке/локальной базе и имеет завершённую продажу. Не доверять renderer-supplied сумме/позициям.

Из выбранного чека автоматически копируются:
- `sourceSaleId`;
- `fiscalNumber`;
- сумма;
- позиции;
- покупатель/телефон, если доступны.

Один и тот же `sourceSaleId` не должен порождать второй активный заказ. Нужна детерминированная проверка перед insert.

На сервере сохранить существующие `source_sale_id` / `fiscal_number` и добавить read-only Link `source_receipt` на `Sales Receipt` для новых заказов, если receipt по external_id найден в той же business point. Никогда не связывать чек другой точки.

## POS UX

Вынести OrdersPage из большого AppV2 в отдельный renderer-компонент.

Основной рабочий список — таблица, не карточки:

`Заказ | Телефон | Описание заказа | Оплата | Создан | Срок готовности | Статус | Действие`

Отображение:
- короткий номер `№ 4567`;
- полный телефон;
- описание не прятать в secondary modal;
- `Оплачено · <сумма> · чек <номер>`;
- createdAt;
- dueAt;
- status;
- одна основная контекстная кнопка.

Сортировка рабочего списка:
1. `new/in_progress`: просроченные первыми, затем ближайший dueAt;
2. `ready`: после рабочих;
3. `issued/cancelled` в рабочем списке не показывать.

Просроченный dueAt визуально выделять понятной меткой, без агрессивного redesign.

Действия:
- в работе → `Готово`;
- готов → крупная `Выдан`;
- отдельное вторичное редактирование телефона/описания/dueAt допустимо;
- не давать кассиру произвольно прыгать между всеми статусами через select.

### Badge меню

Badge `Заказы` = количество только `new + in_progress`.

`ready` не входит в красный счётчик: производство завершено. Если все заказы готовы, badge исчезает.

## Создание из Sale UI

Существующую кнопку `Оформить заказ` сохранить.

Order modal:
- телефон — обязателен;
- описание заказа — обязательно;
- срок готовности — обязателен;
- основная кнопка ведёт к оплате существующим PaymentModal flow.

Кнопку/сценарий `Сохранить без оплаты` убрать из обычного UX. Старый IPC/API можно оставить совместимым, если его удаление расширяет scope, но новый UI его не использует.

## SQLite / contracts / sync

Расширить `Order` optional-полями:
- `readyAt?: string`;
- `issuedAt?: string`.

`dueAt` для legacy остаётся optional в типе, но new-order validation требует его.

SQLite:
- добавить `ready_at TEXT`;
- добавить `issued_at TEXT`;
- использовать существующий `ensureColumn`, отдельная migration framework не нужна;
- старые строки читаются с undefined timestamps.

`updateOrder` должен сам выставлять ready/issued timestamp по переходу; renderer не передаёт произвольные event times.

Outbox payload и server bootstrap должны включать timestamps.

`replaceServerOrders` сохраняет их при roundtrip и не ломает local/server reconciliation.

## Server / POS Order

Расширить DocType `POS Order`:
- `ready_at` Datetime, read-only;
- `issued_at` Datetime, read-only;
- `source_receipt` Link -> Sales Receipt, read-only.

`_apply_order_created` и `_apply_order_updated` принимают timestamps из доверенного POS event payload, но сохраняют monotonic first-event semantics: уже записанное ready_at/issued_at не перезаписывать более поздним duplicate/update.

Существующий `creation` остаётся source of truth для server created time.

`_get_orders` возвращает readyAt/issuedAt и source receipt metadata обратно POS.

## Web OS: Продажи → Заказы

Добавить страницу:
- route `/sales/orders`;
- access area `page.sales.orders`;
- раздел меню `Продажи → Заказы`;
- read-only для этой DEV.

Использовать существующие `SmartFilterBar` + `SmartDataTable`; не создавать отдельную таблицу/filters implementation.

Основные поля таблицы:
- Заказ (короткий номер);
- Телефон;
- Точка;
- Описание;
- Чек;
- Сумма;
- Статус;
- Создан;
- Срок готовности;
- Готов;
- Выдан;
- Время выполнения;
- Просрочка.

Фильтры:
- business entity / business point;
- status;
- search по телефону, внутреннему order_number, description/comment, fiscal number;
- created from/to;
- due from/to;
- ready from/to;
- `Просрочен`.

На этой DEV не добавлять графики/KPI dashboard: главное — корректно хранить timestamps и дать фильтруемый список для дальнейшей CRM-аналитики.

Backend API `get_orders`:
- `@frappe.whitelist()`;
- обязательный `@access_contract(area="page.sales.orders", action="read", scope="point")`;
- `require_access("page.sales.orders", "read")`;
- scope filter на business point/entity через существующие sales helpers;
- client-supplied point не считается авторизацией.

ОС не меняет статус заказа на этой DEV: единственный operational writer — POS. Это исключает конфликт двух рабочих интерфейсов.

## Права и безопасность

- POS: текущая cashier auth + current point;
- Web OS: новая deny-by-default page area;
- никакого доступа к заказам чужой точки;
- никаких новых денежных/fiscal side effects;
- не менять TransactionEngine, TransactionJournal, payment providers, ATOL, INPAS, return flow.

## Совместимость

- старые `new` показываются как «В работе»;
- старые заказы без dueAt/readyAt/issuedAt читаются;
- старый `CreateUnpaidOrderRequest` может остаться в API, но UI больше не создаёт unpaid production orders;
- внутренний unique order_number сохраняется;
- server sync retention 60 дней для POS bootstrap не менять; Web OS history читает DocType напрямую и не ограничивается POS cache.

## Focused tests

Добавить/обновить только связанные tests:
- database: creation/status timestamps, duplicate sourceSale guard, legacy row compatibility;
- sync: readyAt/issuedAt roundtrip server -> POS;
- transaction-engine regression: order from sale всё ещё создаётся только после completed/fiscalized save path;
- backend scoped order list: разрешённая точка видна, чужая нет;
- order ingestion: first readyAt/issuedAt not overwritten by duplicate updates.

Не запускать проверки в coding turn. Финальные typecheck/tests/build/CI делает архитектор отдельно.

## Acceptance

1. Заказ из продажи появляется только после успешной оплаты/фискализации и показывает «Оплачено».
2. Отдельный заказ можно создать только по уже оплаченному чеку текущей точки.
3. Телефон, описание и dueAt обязательны для новых заказов.
4. Кассир видит короткий № из последних 4 цифр телефона, но система сохраняет уникальный internal orderNumber.
5. В работе → Готово фиксирует readyAt.
6. Готов → Выдан фиксирует issuedAt и убирает заказ из POS worklist.
7. Badge считает только new/in_progress.
8. Просроченные active orders заметны.
9. Продажи → Заказы в Web OS показывает point-scoped read-only список и фильтры по timestamps/status/point.
10. Старые заказы и текущая двусторонняя синхронизация остаются совместимыми.
