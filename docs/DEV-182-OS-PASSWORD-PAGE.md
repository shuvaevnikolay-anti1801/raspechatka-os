# DEV-182 — Русская страница создания и изменения пароля в стиле Распечатка OS

## Цель

Привести стандартную Frappe-страницу `/update-password` к тому же пользовательскому уровню, что уже реализован для `/login` в DEV-078:

- полностью русский интерфейс;
- визуально тот же бренд Распечатка OS;
- понятные поля, подсказки и ошибки;
- мобильная адаптация;
- никаких сырых англоязычных сообщений Frappe;
- сохранить штатную безопасность Frappe reset-token/password API.

Пользователь по одноразовой ссылке приглашения должен видеть не стандартную Frappe-форму, а фирменную страницу Распечатка OS.

База: `version-16` @ `8c14e5c4c452050fc4fc4980d3058f11f008f72a`
Ветка: `codex/dev-182-os-password-page`

---

## Исследование текущего состояния

### Уже готово

DEV-078 заменил штатный login:

`/login -> raspechatka/www/os-login.html`

через:

```python
website_route_rules = [
    {"from_route": "/login", "to_route": "os-login"},
]
```

Текущий дизайн и UX находятся в:

- `raspechatka/www/os-login.html`
- `raspechatka/www/os-login.py`
- `raspechatka/public/css/os-login.css`
- `raspechatka/public/js/os-login.js`

Это визуальный и UX reference для DEV-182.

### Почему пользователь видит другую страницу

Выдача доступа пользователю и сотруднику сейчас использует штатный Frappe API:

```python
user._reset_password(send_email=False, password_expired=True)
```

Frappe v16 генерирует ссылку:

```text
/update-password?key=<one-time-token>&password_expired=true
```

Поэтому `/login` уже наш, а `/update-password` продолжает открывать стандартный:

`frappe/www/update-password.html`

В нём используются англоязычные строки:

- Set Password
- Use strong passwords.
- New Password
- Confirm New Password
- Passwords do not match
- Invalid Link
- Password set
- Back to sign in
- и др.

---

## Архитектурное решение

### Не изменять Frappe core

Запрещено редактировать:

- `frappe/www/update-password.html`
- `frappe/core/doctype/user/user.py`
- другие файлы framework.

Вместо этого создать собственную website page Распечатка OS и перенаправить маршрут.

Предпочтительная реализация:

- `raspechatka/www/os-update-password.html`
- `raspechatka/www/os-update-password.py`
- `raspechatka/public/js/os-update-password.js`
- использовать существующий `raspechatka/public/css/os-login.css` как общий auth design system; допустимо добавить только узкие password-page классы.

В `hooks.py`:

```python
website_route_rules = [
    {"from_route": "/login", "to_route": "os-login"},
    {"from_route": "/update-password", "to_route": "os-update-password"},
    ...
]
```

Query parameters `key`, `password_expired`, `redirect_to` должны сохраняться.

---

## Backend security contract

Не создавать собственную систему паролей, reset tokens или таблицу паролей.

Форма должна продолжать использовать штатный endpoint Frappe:

```text
frappe.core.doctype.user.user.update_password
```

Передавать:

- `key` — если пользователь пришёл по одноразовой ссылке;
- `old_password` — если авторизованный пользователь меняет текущий пароль без key;
- `new_password`;
- `logout_all_sessions: 1`.

Frappe остаётся единственным authority для:

- проверки reset key;
- срока жизни / повторного использования ссылки;
- password policy;
- смены password hash;
- завершения старых сессий;
- входа пользователя после успешного reset по key.

Не логировать пароль, reset key или raw payload.

---

## UX: режим 1 — первое создание / reset по ссылке

URL:

`/update-password?key=...`

Карточка в стиле текущего `os-login`.

### Header

Логотип и:

`Распечатка OS`

Заголовок:

`Создание пароля`

Подзаголовок:

`Придумайте пароль для входа в систему`

### Поля

1. `Новый пароль`
2. `Повторите пароль`

Оба поля:
- password input;
- кнопка `Показать / Скрыть`;
- autocomplete=new-password.

### Подсказка

Понятный русский текст, например:

`Минимум 8 символов. Добавьте цифры или специальные знаки.`

Если используется server strength score, labels только русские:

- Слабый
- Средний
- Хороший
- Надёжный

Не выводить raw Frappe feedback/suggestions.

### CTA

`Создать пароль`

Loading:

`Сохраняем…`

---

## UX: режим 2 — изменение пароля

URL:

`/update-password` без key для уже авторизованного пользователя.

Заголовок:

`Изменение пароля`

Поля:

1. `Текущий пароль`
2. `Новый пароль`
3. `Повторите пароль`

CTA:

`Изменить пароль`

Этот режим тоже должен быть полностью русским и в том же дизайне.

---

## Клиентская валидация

До отправки:

- пустой новый пароль -> `Введите новый пароль`;
- пароль короче 8 символов -> `Пароль должен содержать не менее 8 символов`;
- повтор не совпадает -> `Пароли не совпадают`;
- в режиме change пустой old -> `Введите текущий пароль`;
- новый пароль равен текущему -> `Новый пароль должен отличаться от текущего`.

Клиентская проверка не заменяет backend policy.

---

## Русская обработка backend ошибок

Никогда не показывать пользователю:

- traceback;
- `_server_messages`;
- exception class;
- raw `responseJSON.message`;
- английский текст Frappe.

Минимальная карта:

### 401
`Текущий пароль указан неверно`

### 410 / invalid reset key
`Ссылка недействительна или уже использована. Попросите руководителя создать новую ссылку.`

### password policy rejection
`Пароль не соответствует требованиям безопасности. Сделайте его сложнее.`

### 429
`Слишком много попыток. Попробуйте позже.`

### network/unknown
`Не удалось сохранить пароль. Попробуйте ещё раз.`

---

## Success flow

После успешного reset:

Показать внутри карточки:

`Пароль сохранён`

`Теперь вы можете работать в Распечатка OS.`

Далее перейти по безопасному внутреннему redirect.

Правило redirect:

1. принять backend `r.message` только если это относительный внутренний путь, начинающийся с `/` и не с `//`;
2. если route отсутствует/невалиден — `/raspechatka`.

Не позволять open redirect.

Кнопка/ссылка:

`Продолжить`

Для приглашённого System User Frappe после успешного reset по key уже выполняет `login_as(user)`; не создавать вторую auth-схему.

---

## Визуальный контракт

Новая страница должна визуально восприниматься как продолжение текущего `/login`:

- тот же фон;
- та же белая card;
- тот же логотип;
- та же типографика;
- те же размеры input/button;
- те же green/danger tokens;
- те же focus states;
- тот же max-width;
- тот же responsive breakpoint.

Не копировать новый несвязанный дизайн.

Предпочтение: переиспользовать существующие CSS classes `.os-login*`, `.os-field`, `.os-password-wrap`, `.os-login-submit`.

Если нужен рефакторинг в общий auth CSS, он допустим только без visual regression существующей страницы login.

---

## Accessibility / browser behavior

- labels связаны с inputs;
- errors имеют `role="alert"` / aria-live где уместно;
- Enter submit работает;
- double submit заблокирован;
- autofocus на первом видимом поле;
- password toggle не submit;
- Escape ничего критичного не делает;
- mobile 320px+ без horizontal overflow.

---

## Совместимость с текущим invitation flow

НЕ менять существующую выдачу приглашений в:

- `raspechatka/api/users.py::generate_invitation`
- `raspechatka/api/team.py`

Они должны продолжать вызывать:

```python
user._reset_password(send_email=False, password_expired=True)
```

Ссылка остаётся `/update-password?key=...`.

Меняется только rendering route.

---

## Тесты

### Contract/source tests

1. `hooks.py` содержит route `/update-password -> os-update-password`.
2. Custom page содержит только русские visible labels/messages.
3. Existing `/login` route и DEV-078 tests не ломаются.
4. Invitation flow по-прежнему вызывает Frappe `_reset_password`.
5. JS не рендерит raw backend errors.

### JS/unit tests

Покрыть pure helpers:

- key detection;
- matching passwords;
- min length;
- safe redirect;
- public error mapping;
- double-submit guard.

### Frappe integration

1. Создать User/Profile.
2. Получить `_reset_password(... password_expired=True)`.
3. Проверить generated link содержит `/update-password?key=`.
4. Вызвать standard Frappe `update_password` с key.
5. Новый пароль реально работает для Raspechatka login.
6. Reset key становится одноразовым.
7. Повторное использование key -> invalid/410.
8. Успешный reset авторизует пользователя как раньше.
9. `logout_all_sessions=1` сохранён.

### Build

- Python AST / Ruff relevant files;
- JS test;
- frontend existing tests/build only if touched;
- application tests for auth;
- production smoke after deploy:
  - generate invitation;
  - open link;
  - create password;
  - enter Web OS with phone + created password.

---

## Acceptance criteria

DEV считается готовым только если:

1. Ссылка приглашения открывает фирменную Распечатка OS page, а не Frappe card.
2. На странице нет пользовательского английского текста.
3. Новый пароль + повтор понятны.
4. Ошибки полностью русские и не содержат внутренней информации.
5. Invalid/used link объяснён человеку.
6. Пароль реально сохраняется штатным Frappe backend.
7. После создания пароля пользователь может войти через существующий русский `/login`.
8. Existing login UX не изменился визуально.
9. Existing reset security не ослаблена.
10. Не изменён Frappe framework core.
