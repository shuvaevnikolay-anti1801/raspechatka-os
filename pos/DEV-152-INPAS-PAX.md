# DEV-152 — Точка / INPAS DualConnector / PAX

## Цель

Сделать production-интеграцию Windows POS с эквайрингом банка Точка через уже установленный банком INPAS DualConnector и PAX-терминал. Пользователь не должен знать COM-порт, DLL, путь к DC Console, код валюты или Terminal ID.

Целевой UX:
1. Банк Точка устанавливает свой «Интегратор» и настраивает PAX штатными средствами.
2. Распечатка автоматически видит установленный INPAS/DualConnector.
3. В «Настройки → Эквайринг» показываются драйвер/терминал/статус и кнопки «Обновить», «Проверить связь», «Сверка итогов».
4. Продажа: банк APPROVED → затем ККТ.
5. Возврат: банковский Refund по evidence исходной продажи → затем ККТ возврата.
6. Неопределённый банковский исход никогда не повторяется вслепую.

## Фактическая установка Точки, исследованная до разработки

На рабочем ПК установлен каталог C:\Program Files (x86)\INPAS\DualConnector.

Факты:
- DualConnector.dll version 1.3.18.0;
- DualConnector.tlb;
- DC Control.exe;
- DC Console.exe;
- x86/x64 варианты DualConnector.dll;
- RegisterDC.bat по умолчанию регистрирует x64 через RegAsm/GAC;
- DualConnector.xml содержит банковскую конфигурацию устройства (на исследованной точке COM3 / 115200), но НЕ содержит Terminal ID.

TypeLib/assembly содержит COM-visible типы и поля:
- DualConnector.DCLink;
- DualConnector.SAPacket;
- Exchange;
- ReferenceNumber;
- TerminalID;
- TransactionStatus;
- AuthorizationCode;
- DeviceSerNumber;
- ModelNo;
- ReceiptData.

Не добавлять банковские DLL/TLB/config/license в репозиторий или installer. Их устанавливает и обновляет Точка.

## Архитектура

Основной путь:

React
→ Electron main
→ PosTransactionEngine
→ PaymentProvider
→ InpasDirectPaymentProvider
→ NativeInpasBridge
→ Raspechatka.InpasBridge.exe
→ зарегистрированный INPAS DualConnector
→ PAX
→ банк Точка

Существующий inpas.ts / DC Console.exe + result.txt сохранить как hidden legacy/diagnostic fallback. Новая реализация не должна удалять console adapter.

## Native bridge

Новый helper:
- Windows x64;
- имя Raspechatka.InpasBridge.exe;
- .NET Framework 4.8 x64 (банковский DualConnector 1.x зарегистрирован через RegAsm/GAC и рассчитан на CLR v4/v2);
- late-bound COM/OLE через Type.GetTypeFromProgID / Activator.CreateInstance / dynamic;
- ProgID-кандидаты DualConnector.DCLink и DualConnector.SAPacket;
- без compile-time ссылки на DualConnector.dll;
- все COM-вызовы на одном dedicated STA thread и строго последовательно;
- stdin/stdout JSON-lines, protocolVersion=1, request id;
- stdout только protocol JSON, stderr только logs;
- timeout опасной банковской команды означает UNKNOWN, не «не выполнено»;
- после зависания helper можно перезапустить, но исходную банковскую команду автоматически повторять нельзя.

Bridge-команды:
- driverInfo;
- discover;
- status;
- testConnection;
- sale;
- refund;
- void;
- reconcile;
- recoveryProbe — только если можно доказательно реализовать;
- shutdown.

## Обнаружение и Terminal ID

Обычный UI не содержит ручного Terminal ID.

Безопасный discovery:
1. кандидат из уже сохранённого settings;
2. кандидат из последнего успешного INPAS/DualConnector результата/лога — читать только безопасные поля, прежде всего SA [27] Terminal ID;
3. кандидат обязательно проверяется read-only/test операцией 26.

НЕЛЬЗЯ делать продажу 1 только ради определения Terminal ID. Штатный тестовый BAT INPAS использует bootstrap sale с тестовым ID, но production POS так делать не должен.

Если TID ещё нигде нет, UI говорит: «INPAS установлен, терминал ещё не инициализирован. Выполните проверку связи в DC Control, затем нажмите Обновить».

COM-порт/baud — банковская конфигурация. POS их не редактирует и не показывает кассиру.

## Банковские операции

Подтверждённые коды:
- 1 — sale;
- 29 — refund;
- 4 — void/cancel, отдельная операция;
- 26 — test connection;
- 59 — reconciliation.

Текущий код ошибочно использует 4 как refund — исправить.

## Banking evidence

Текущего PaymentPart.transactionId недостаточно. После APPROVED сохранять безопасное evidence:
- provider/adapter;
- terminalId;
- referenceNumber / RRN, если возвращается;
- terminalTransactionId, если возвращается;
- authorizationCode;
- responseCode/status;
- amountMinor;
- bank operation kind;
- started/completed timestamps;
- terminal model/serial, если возвращается;
- безопасный receipt/result subset.

Не сохранять PAN, PIN, track data, ключи и секреты. Diagnostics тоже без PII/PCI.

Нынешняя генерация transactionId из SA [12]/[13]/[14]/[25] не является доказательным bank reference. [25] — код операции и не может быть уникальным transaction id.

## Продажа

1. TransactionEngine создаёт payment_attempt и сохраняет intent ДО банковского sale.
2. Выполнить ровно один sale.
3. APPROVED только по однозначному ответу DualConnector.
4. Сохранить evidence.
5. Затем фискализация АТОЛ.
6. Если declined — ККТ не вызывать.
7. timeout/crash/lost response → payment_unknown; blind retry запрещён.

## Возврат

Return должен получать evidence исходной банковской продажи.

Для card/qr INPAS:
- использовать operation 29 Refund;
- передавать исходный ReferenceNumber/RRN/TID и другие поля, реально требуемые установленным DualConnector/банком;
- после APPROVED выполнять фискальный возврат АТОЛ;
- operation 4 не использовать как общий refund.

Если исходного evidence недостаточно, банковский возврат не начинать и показать понятную причину.

## Recovery

Существующие состояния payment_in_progress / payment_unknown — safety boundary.

Правило:
- unknown никогда не переводить автоматически в declined;
- unknown никогда не повторять автоматически;
- новая денежная операция остаётся заблокированной, пока опасная предыдущая не разрешена.

Автоматический approved/declined recovery реализовать ТОЛЬКО если DualConnector даёт evidence, которое однозначно сопоставляется с исходной попыткой по Reference/RRN/TID/amount/kind/time.

Названия TransactionStatus, SAO_TRANSACTION_LOG и OperationStatus сами по себе не являются достаточным доказательством.

Если установленная версия не позволяет доказательный lookup:
- getOperationStatus возвращает unknown;
- recovery UI объясняет, что результат надо проверить в терминале/банковском журнале;
- никакого blind retry.

Hardware acceptance обязан отдельно проверить crash/USB-loss после возможного банковского APPROVED.

## Settings V2

Новая схема INPAS settings:
- version: 2;
- enabled;
- adapter: direct | console;
- direct.selectedDevice / найденный terminal identity: TID/model/serial, только безопасные данные;
- legacy console fields executablePath, old terminalId, currency/timeout сохранить для совместимости.

Новые установки → direct.
Старые settings мигрировать без потери legacy console config.
Обычный UI показывает direct flow; console adapter доступен только как hidden/advanced fallback.

## TransactionJournal

Идемпотентно расширить payment_attempts, не ломая старые SQLite:
- provider/adapter;
- terminal_id;
- reference_number;
- terminal_transaction_id;
- authorization_code;
- response_code;
- request_hash;
- started_at уже есть;
- completed_at уже есть;
- безопасный raw subset можно оставить JSON.

getLatestPaymentAttempt должен возвращать evidence для recovery.
Сохранённые PaymentPart исходной продажи должны позволять безопасно сформировать банковский refund.

## UI

Обычный SettingsHub:
- «Эквайринг Точка / INPAS»;
- состояние DualConnector и версия;
- найденный PAX: model/serial/TID, если доступны;
- «Обновить»;
- «Подключить / сохранить»;
- «Проверить связь»;
- «Сверка итогов».

Не показывать:
- путь к EXE/DLL;
- COM/baud;
- currency 643;
- ручной timeout;
- ручной Terminal ID.

Если терминал отключён — «Терминал не подключён».
Если INPAS не установлен/COM class не зарегистрирован — «Установите/восстановите Интегратор Точки».

## Packaging

Raspechatka.InpasBridge.exe собирается как .NET Framework 4.8 x64 и кладётся в extraResources. ATOL bridge остаётся отдельным .NET 8 helper.

Не bundle:
- DualConnector.dll;
- DualConnector.tlb;
- банковские drivers/config/license;
- DC Control/DC Console.

Runtime path:
- packaged → process.resourcesPath/native/inpas/Raspechatka.InpasBridge.exe;
- dev → RASPECHATKA_INPAS_BRIDGE_PATH или локальный publish path.

## Diagnostics

Без PII/PCI:
- inpas.driver.detected/missing;
- inpas.device.discovered/selected/connected/disconnected;
- payment.started/approved/declined/unknown;
- refund.started/approved/declined/unknown;
- payment.recovery.started/resolved/unresolved;
- inpas.reconcile.completed/failed.

Допустимые details: driverVersion, terminalId, model, serial, amountMinor, operation kind, referenceNumber/RRN, authorizationCode, responseCode, error code/description. Не писать PAN/track/PIN.

## Acceptance

Автоматически:
- settings migration;
- bridge protocol;
- sale/refund/void/reconcile mapping;
- banking evidence parsing;
- no operation 4 as refund;
- no SA [25] as transaction identity;
- no blind retry;
- journal migration old DB;
- direct UI hides technical fields;
- package contains только наш bridge.

Реальная Windows + Точка + PAX:
- INPAS detection;
- discovery/TID validation;
- test connection;
- sale;
- declined sale;
- Refund 29 tied to original sale;
- reconciliation 59;
- terminal unplugged;
- helper crash/timeout;
- POS restart after unknown;
- отсутствие двойного charge/refund;
- взаимодействие с АТОЛ: bank APPROVED → fiscal; bank unknown/declined → no fiscal.
