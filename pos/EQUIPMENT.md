# Подключение оборудования

POS отделяет бизнес-логику от конкретного оборудования через provider-контракты. Экран продажи не должен напрямую знать детали ККТ, банковского терминала или Windows-печати.

## ККТ АТОЛ

Основной production-путь DEV-151:

Windows POS
→ FiscalProvider
→ AtolDriverFiscalProvider
→ Raspechatka.AtolBridge.exe
→ установленный официальный ATOL Driver 10
→ ККТ АТОЛ

ATOL Web Requests сохранён как hidden legacy fallback. Неопределённый результат фискализации после timeout/crash/USB loss не повторяется вслепую; используется recovery evidence. Полная спецификация: pos/DEV-151-ATOL-DRIVER.md.

## Банковский терминал

Текущий legacy-путь в inpas.ts запускает INPAS DC Console и читает result.txt. Он остаётся fallback, но DEV-152 переводит основной путь на прямой bridge к установленному банком INPAS DualConnector:

Windows POS
→ PaymentProvider
→ InpasDirectPaymentProvider
→ Raspechatka.InpasBridge.exe
→ зарегистрированный INPAS DualConnector
→ PAX
→ банк Точка

Фактическая исследованная установка Точки — DualConnector 1.3.18.0 в C:\Program Files (x86)\INPAS\DualConnector, с x64/x86 DLL и COM registration через RegAsm/GAC. Банковские DLL/TLB/config/license не включать в POS installer.

Коды операций для целевой реализации:
- 1 — sale;
- 29 — refund;
- 4 — void/cancel, не refund;
- 26 — test connection;
- 59 — reconciliation.

Обычный пользователь не настраивает COM/baud/DLL/path/currency/Terminal ID. Timeout/crash/lost response после начала банковской операции означает payment_unknown; автоматический повтор charge/refund запрещён.

Полная архитектура и hardware acceptance: pos/DEV-152-INPAS-PAX.md.
