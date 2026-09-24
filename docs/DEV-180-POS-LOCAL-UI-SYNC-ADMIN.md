# DEV-180 — Локальные настройки таблицы заказов и полный admin control sync queue

## Цель

Два небольших эксплуатационных улучшения Windows POS в одном DEV:

1. Сохранять настроенную кассиром ширину колонок страницы «Заказы» локально на конкретной установленной кассе, а не сбрасывать при каждом переходе между страницами.
2. Дать администратору Retry/Delete для любого события, реально находящегося в POS outbox queue, включая shift/sale/cash events.

База: `version-16` @ `222243b4b8740ff1ae10ea4c08f292eace9955f1`  
Ветка: `codex/dev-180-pos-local-ui-sync-admin`

---

## Исследование текущего кода

### 1. Orders column widths

`pos/src/renderer/src/OrdersPage.tsx`:
- `columnWidths` создаётся через `useState(defaultOrderColumnWidths())`;
- resize меняет только renderer state;
- после unmount/remount страницы значения теряются;
- min/max и текущая responsive grid logic уже существуют и должны сохраниться.

`pos/src/main/database.ts`:
- SQLite уже имеет `app_state(key PRIMARY KEY,value)`;
- public `getState()/setState()` используются для локальной persistent state;
- нет смысла создавать новую таблицу только для UI preference.

Целевой persistence contract:
- хранить настройку локально в SQLite этой установки POS;
- scope = текущий point/workplace, чтобы переподключение одной установки к другой кассе не наследовало случайно старую геометрию;
- ключ вида `ui:orders:column-widths:v1:<pointId>:<workplaceId>` либо эквивалент;
- value = JSON map только известных column keys;
- при чтении validation/clamp обязателен;
- неизвестные старые keys игнорируются, новые колонки получают default width;
- corrupt JSON безопасно сбрасывается на defaults;
- не писать SQLite на каждый pointermove; persist после pointerup/pointercancel/final width change;
- preference не зависит от employee/cashier session;
- logout/lock/page switch/app restart не сбрасывают настройку;
- новая ручная регулировка заменяет сохранённое значение.

Нужен узкий IPC/API, а не renderer-доступ к БД:
- `getOrderTableColumnWidths()`
- `saveOrderTableColumnWidths(widths)`
или generic local UI preference API, только если он остаётся строго local/main-owned и не превращается в произвольный key/value bridge.

### 2. Sync queue admin actions

После DEV-178:
`pos/src/main/sync-queue-policy.ts` содержит explicit allowlist:
- order.created
- order.updated
- stock.write_off.requested
- stock.receipt.requested
- point.supply.requested
- cleaner.visit.recorded

Из-за этого кнопок нет для:
- shift.opened
- shift.closed
- sale.completed
- sale.returned
- cash.deposited
- cash.withdrawn
- cash.counted
и будущих типов событий.

`retrySingleSyncEvent()` уже:
- сериализован через `withOutboxLock`;
- отправляет строго один immutable event id/payload;
- использует существующий server idempotency contract.

`discardSingleSyncEvent()` уже:
- сериализован тем же lock;
- переводит event в terminal `discarded`, а не маскирует как sent;
- сохраняет локальный business document;
- пишет audit diagnostic.

Целевое изменение:
- администраторская политика должна быть generic для любого outbox event со status `pending|problem`;
- `canRetry` и `canCancel` больше не зависят от eventType allowlist;
- existing global block остаётся: если есть blocking payment/fiscal recovery либо outbox paused, destructive/manual sync actions не должны обходить этот safety barrier;
- explicit `order.updated.updatedAt` validation не должна скрывать кнопку. Если payload старый/битый, ручной Retry честно повторяет его и показывает server error; Delete позволяет администратору прекратить попытки;
- future unknown event types, если они уже лежат в outbox, также получают actions;
- payment/fiscal UNKNOWN не являются outbox events и по-прежнему НЕ получают эти generic actions;
- discard shift/sale/cash event может сознательно создать рассинхронизацию OS ↔ local POS. Это разрешённый admin break-glass action по бизнес-решению. Подтверждение должно явно предупреждать именно об этом, но не запрещать действие;
- audit diagnostic для discard должен включать id,eventType,createdAt и пометку admin break-glass.

---

## DEV-180 (1) — Persistent widths страницы «Заказы»

### Files

- `pos/src/renderer/src/OrdersPage.tsx`
- `pos/src/main/database.ts`
- `pos/src/main/ipc.ts`
- `pos/src/preload/index.ts`
- `pos/src/shared/contracts.ts`
- focused orders/database/IPC tests.

### Реализация

1. Add main-owned read/write methods for order table widths.
2. Resolve current pointId/workplaceId from confirmed bootstrap/local context.
3. Store in `app_state`, versioned key scoped to physical workplace.
4. Renderer loads persisted widths on mount/page entry.
5. Merge persisted values with current `ORDER_TABLE_COLUMNS` defaults.
6. Every loaded/saved value passes `clampOrderColumnWidth()` equivalent validation in a shared/pure place. Main must not blindly trust renderer JSON.
7. Persist only when resize finishes, not each pointermove.
8. No cashier id in key.
9. No server sync/outbox for this preference.
10. If bootstrap/workplace context unavailable, use defaults and do not fail Orders page.

### Acceptance

- resize one or several columns → leave Orders → return → widths identical;
- app restart → widths identical;
- another cashier on same POS gets same widths;
- current point/workplace A and B can have different saved layouts;
- corrupt/legacy JSON falls back safely;
- new column added in future gets default while existing saved columns survive;
- min/max still enforced;
- no write storm during pointer drag.

---

## DEV-180 (2) — Retry/Delete для всех outbox events

### Files

- `pos/src/main/sync-queue-policy.ts`
- `pos/src/main/sync.ts`
- `pos/src/main/ipc.ts`
- `pos/src/renderer/src/SettingsHub.tsx`
- `pos/src/shared/contracts.ts` only if additive warning metadata helps UX
- focused sync/settings/database tests.

### Реализация

1. Replace event-type allowlist with generic policy:
   - status pending/problem;
   - not globally blocked;
   - event exists and still unsent.
2. Retry action always sends exactly selected event via existing `retrySingleSyncEvent`.
3. Delete/discard allowed for any selected outbox event including shift/sale/cash.
4. Keep immutable event id/payload on retry.
5. Keep terminal `discarded` semantics and pending counts behavior.
6. Keep admin code gate and outbox lock.
7. Keep transactionEngine blocking-operation/outbox-paused barrier.
8. Update discard confirmation copy:
   - ordinary events: local document remains, server delivery stops;
   - shift/sale/cash events: additionally warn that OS may no longer receive this accounting/shift event and manual reconciliation may be needed.
9. Do NOT add generic actions to `TransactionJournal` unresolved payment/fiscal rows.
10. Remove obsolete comments/tests claiming financial/shift outbox events are permanently protected from admin discard/retry.

### Acceptance

For each representative event:
- order.created
- cleaner.visit.recorded
- shift.opened
- shift.closed
- sale.completed
- sale.returned
- cash.deposited
- cash.withdrawn
- cash.counted
- unknown/future.event

when status pending/problem and no global block:
- UI shows «Отправить сейчас»;
- UI shows «Удалить из очереди»;
- Retry touches only selected event;
- Delete marks only selected event discarded and removes it from pending count;
- restart does not resurrect discarded event;
- audit diagnostic recorded;
- server rejection remains visible after Retry;
- no blind interaction with payment/fiscal TransactionJournal.

---

## Финальная проверка

After part (2):
- focused tests for orders preference persistence;
- focused outbox/sync/settings tests;
- POS typecheck;
- full POS tests/build before PR;
- no backend/Frappe migration expected.

Final report:
- exact SQLite key/schema used for column widths;
- proof setting is workplace-local and cashier-independent;
- proof all outbox event types expose admin actions;
- proof payment/fiscal recovery remains separate.
