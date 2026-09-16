# Единая рабочая область списков

Списочные страницы Raspechatka OS собираются из трёх общих компонентов:

- `ListPageHeader.vue` — название текущего раздела и контекстные действия справа;
- `SmartFilterBar.vue` — выбираемые поля фильтра, применение, очистка и персональные закладки;
- `SmartDataTable.vue` — выбираемые столбцы, изменение ширины, итоги и пагинация.

Настройки хранятся в `User View Preference` отдельно для пользователя и `viewKey`. Фильтр использует ключ `<viewKey>.filters`, таблица — `<viewKey>.table`, поэтому компоненты не перезаписывают настройки друг друга.

## Entity field descriptor

Стандартная страница задаёт один массив `entityFields`. Поле описывается один раз через `key`, `label` и бизнес-смысл. Из этого массива строятся карточка, дополнительные фильтры и столбцы. Особенности представления задаются вложенными `form`, `filter`, `table`; значение `false` отключает поле только в соответствующем представлении. Общие свойства (`type`, `options`, `searchable`, форматирование, обязательность) не дублируются.

```js
const entityFields = defineEntityFields([
  { key: "search", label: "Поиск", placeholder: "Название или телефон", form: false, filter: false, table: false },
  { key: "title", label: "Название", searchable: true, form: { required: true }, table: { primary: true } },
  { key: "phone", label: "Телефон", searchable: true },
  { key: "active", label: "Статус", form: false, filter: { type: "select", options: statusOptions }, table: { renderer: "status" } },
]);
```

`search` — специальное состояние страницы. Оно всегда отображается справа в шапке «Фильтр», не входит в ⚙ и не может быть скрыто. `searchable: true` или декларативный `searchKeys` определяет серверные поля общего поиска; сам `SmartFilterBar` не выбирает их.

Таблица показывает бизнес-представление значения, не способ его хранения. Для `select` один массив `options` используется формой, фильтром и таблицей: в API остаётся raw `value`, а пользователь видит `label`. Для Link-поля backend сохраняет raw ID и пакетно возвращает отдельное display-поле, которое descriptor объявляет через `table.displayKey` или общий `displayKey`:

```js
{
  key: "organization",
  label: "Партнёр",
  type: "link",
  table: { displayKey: "organization_label" },
}
```

Обычный `check` без специального renderer отображается как «Да/Нет». Приоритет отображения: slot или `format`, затем `displayKey`, затем label из `options`, затем Check, затем scalar. Нельзя заменять raw Link ID названием или загружать названия отдельным запросом для каждой строки; list API использует join/batch hydration. Client-side сортировка Link/Select выполняется по тому же display-значению. Для server-side сортировки при необходимости задаётся безопасный backend `sortKey`.

Metadata DocType разрешено использовать только для типа и серверной валидации уже объявленного поля. Metadata не является UI-схемой и не добавляет `name`, `owner`, `creation`, `modified`, `modified_by`, `docstatus` или другие поля автоматически. Backend независимо проверяет поля динамического фильтра по allowlist и применяет access/scope.

## Правила подключения

1. `viewKey` должен быть постоянным и уникальным для типа списка, например `warehouse.receipts`.
2. В `SmartFilterBar` и `SmartDataTable` передаётся один `entityFields`. Не создавайте независимые `formFields`, `filterFields` и `tableColumns` для одной сущности.
3. Загрузка данных запускается по событиям `apply` и `reset`.
4. Денежные и количественные поля отмечаются в `table` как `number: true`; checkbox selection остаётся системным фиксированным столбцом.
5. Для итоговой строки передаётся объект `totals`, ключи которого совпадают с ключами столбцов.
6. Нестандартное содержимое ячейки выводится через слот `cell-<key>`.
7. Для Link-поля с техническим ID укажите `displayKey`; для enum задайте общий `options`. Не добавляйте локальные formatter-словари, если достаточно стандартного display resolver.

`<viewKey>.table` хранит `columns`, `columnOrder`, `widths`, `pageSize`. При изменении схемы удалённые ключи отбрасываются, сохранённый порядок существующих остаётся, новые поля добавляются в canonical order. Аналогичное reconciliation применяется к фильтрам и закладкам.

Новые списочные страницы не должны заново реализовывать хранение столбцов, порядка, ширины, закладок или пагинацию.
