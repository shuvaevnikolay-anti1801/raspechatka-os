# DEV-179 — Разделить POS-доступ сотрудника и Web OS пользователя

## Цель

Окончательно разделить две независимые сущности:

- **Employee** — человек/сотрудник и источник права работать в Windows POS;
- **Raspechatka User Profile + Frappe User** — только учётная запись для Web OS.

После DEV-179 обычному кассиру Windows POS не требуется создавать User/Profile, приглашение или web-пароль.

База: `version-16` @ `222243b4b8740ff1ae10ea4c08f292eace9955f1`  
Ветка: `codex/dev-179-employee-pos-access`

## Найденный дефект

В карточке Employee шаг «Доступ» отправляет `access_profile: "Cashier"` в `grant_employee_access()`.
Поле `Raspechatka User Profile.access_profile` — Link на Role, а реальная роль называется `Raspechatka Cashier`. На production это даёт:

`Could not find Рабочая роль: Cashier`

Не исправлять дефект заменой строки `Cashier -> Raspechatka Cashier`: это сохранит неправильное архитектурное связывание POS и Web OS.

## Исторический контекст

- PR #30 / commit `2649f77e...`: users и employees были разделены.
- DEV-086 затем сделал source of truth кассиров POS через `Raspechatka User Profile + linked_employee + point scope`.
- Текущий `raspechatka/api/pos_device.py::_point_employees()` требует:
  - active Raspechatka User Profile;
  - access_profile = Raspechatka Cashier;
  - linked_employee;
  - profile scope к точке;
  - enabled Frappe User;
  - active Employee.
- Тест `tests/test_cashier_pos_only_contract.py` прямо фиксирует, что `Employee Point Assignment` не используется в POS allowlist.

DEV-179 меняет эту authority-модель.

## Целевая модель

### POS access

Сотрудник появляется в Windows POS, если одновременно:
1. `Employee.active = 1`;
2. `Employee.pos_access_enabled = 1`;
3. у Employee есть `Employee Point Assignment` на текущую Business Point.

Должность Employee не является permission.

Если Employee назначен на несколько рабочих точек и POS access включён, он доступен на всех этих назначенных точках.

Windows POS продолжает получать тот же `employees[]` bootstrap contract. Локальный 4-digit PIN, cashier session, offline cache, shift ownership и Device ID/Token не меняются.

### Web OS access

Web OS user существует только если сотруднику реально нужен Web OS.

- `Raspechatka User Profile` / `User` остаются Web OS access model.
- В Employee UI «Кассир» больше не создаётся как Web OS role.
- UsersPage не предлагает `Raspechatka Cashier` для нового пользователя.
- Existing legacy cashier profiles сохраняются как compatibility data; не удалять их автоматически.
- Если Employee с legacy cashier profile позже получает Point Manager access, можно безопасно переиспользовать существующий profile/system_user и сменить его web role.

## Миграция existing cashiers

Добавить Employee field:
- `pos_access_enabled` Check, label «Доступ к кассе», default 0.

Migration/backfill:
- выставить `pos_access_enabled=1` только тем linked Employee, которые до миграции фактически проходили старый effective POS allowlist:
  - Employee active;
  - profile active;
  - access_profile = Raspechatka Cashier;
  - linked_employee set;
  - system_user set and User.enabled=1.
- не создавать/не удалять Employee Point Assignment;
- не удалять Raspechatka User Profile/User;
- patch идемпотентный;
- логика новых POS rights после миграции определяется Employee point assignments.

## Open shift safety

Нельзя:
- выключить `pos_access_enabled`;
- деактивировать Employee;
- убрать у Employee Business Point,

если у этого Employee есть открытая Sales Shift, которую затрагивает изменение.

Существующий guard для active/removed points переиспользовать и расширить на `pos_access_enabled`.

## Части

### (1) Data + backend POS authority + migration

Читать:
- `raspechatka/raspechatka_os/doctype/employee/employee.json`
- `employee.py`
- `employee_point_assignment.json`
- `raspechatka/api/pos_device.py`
- `raspechatka/api/pos_v2.py`
- `raspechatka/api/team.py` save_employee / access helpers
- `raspechatka/patches.txt`
- current cashier/security/POS tests.

Сделать:
1. Additive Employee.pos_access_enabled.
2. Replace `_point_employees()` authority with Employee + Employee Point Assignment.
3. No User/Profile/System User requirement for POS list or push_events cashier validation.
4. Preserve point scope and active employee validation.
5. Add migration from effective legacy Cashier profiles.
6. Extend open-shift guard when POS access is revoked.
7. Update tests that currently assert profile-based allowlist.

Acceptance:
- Employee active + pos_access + current point => in bootstrap even with no User/Profile.
- same employee other point => absent.
- inactive or pos_access off => absent.
- removing right after sync revokes new POS work.
- delayed events still validated against current point employee.
- migration preserves current effective cashiers.

### (2) Employee/Web OS UX separation

Читать:
- `frontend/src/pages/EmployeesPage.vue`
- `raspechatka/api/team.py` get_employee_editor/grant_employee_access/set_employee_access_active
- `frontend/src/pages/UsersPage.vue`
- `raspechatka/api/users.py`
- Raspechatka User Profile controller
- focused frontend/backend tests.

Сделать:
1. Employee step 2 («Трудоустройство») add clear checkbox «Доступ к Windows-кассе».
2. Existing «Точки работы» remain the POS point scope; no second POS point picker.
3. Step 4 rename/position as «Доступ в ОС» / Web OS access.
4. Remove Cashier option from Employee web-access selector. From Employee card only Point Manager web access remains in current feature set.
5. `grant_employee_access()` no longer creates cashier profile. Reject/route `Cashier` as deprecated POS path with human-safe message rather than Frappe Link error.
6. Existing legacy cashier profile must not make UI claim that employee has Web OS access. If granting Point Manager, reuse the profile safely rather than hitting linked_employee uniqueness.
7. UsersPage/get_options must not offer `Raspechatka Cashier` for new Web OS users; backend must independently reject creating a new cashier Web profile from users API.
8. Keep legacy cashier role/security code only for backwards compatibility, not as new authority.

Acceptance:
- create Employee + point + POS checkbox, save: no User/Profile created.
- no invitation generated for POS-only employee.
- web access is optional and separate.
- Point Manager grant still creates/reuses User Profile and invitation.
- error «Could not find Рабочая роль: Cashier» becomes impossible in normal UI/API flow.

### (3) POS/offline/revoke regression + cleanup

Читать:
- `pos/src/main/sync.ts`
- POS cashier auth/session/database tests
- `tests/test_cashier_pos_only_contract.py`
- `raspechatka/tests/test_cashier_security.py`
- relevant DEV-086/DEV-171 regression tests.

Do not rewrite local PIN/session model.

Prove:
1. bootstrap sync replaces local point employee list from Employee-based allowlist;
2. offline known cashier still logs in with existing local PIN;
3. newly POS-enabled Employee appears after successful sync and sets PIN locally;
4. revoked/disabled Employee disappears after successful sync and cannot start new work;
5. open shift remains safe/closable according to current contract;
6. no web password/phone login participates in POS authentication;
7. renderer cannot invent cashierId; main-session/server validation unchanged;
8. current shift, sale, return, cash actions, warehouse actions remain attributed to canonical Employee ID.

Cleanup obsolete tests/comments that claim Raspechatka User Profile is POS authority. Keep legacy web cashier role tests only where they protect old account isolation.

## Non-goals

- no redesign of 4-digit local PIN;
- no change to Device ID/Token;
- no automatic deletion of legacy Users/Profiles;
- no role-by-position logic;
- no second POS user model;
- no change to payroll/schedule semantics beyond Employee Point Assignment now also scoping POS when pos_access_enabled=1.

## Final gate

After all parts:
- backend focused tests + full server CI;
- POS typecheck + full POS tests/build;
- migration test;
- browser contract test for Employees/Users;
- verify clean upgrade from existing cashier profile and clean creation of POS-only employee.

Final report must state:
- source of truth for POS cashier;
- source of truth for Web OS user;
- exact migration behavior;
- open-shift revoke behavior;
- confirmation that POS-only Employee has no Frappe User requirement.
