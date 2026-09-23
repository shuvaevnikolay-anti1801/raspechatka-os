import { useEffect, useMemo, useState } from "react";
import type {
  BootState,
  ConnectionConfig,
  ConnectionStatus,
  DeviceStatuses,
  DiagnosticEvent,
  InpasSettings,
  SyncQueueSnapshot,
  SyncQueueItem,
  PrintJobSummary,
  PrinterInfo,
  UnresolvedOperation,
  AtolDriverDevice,
  AtolDriverInfo,
  AtolDriverStatus,
  AtolSettings,
} from "../../shared/contracts";
import { formatPersonShortName } from "./person-name";
import { PinEntryLayout, PinInput } from "./PinEntry";
import { PosButton, PosIconButton } from "./ui/PosButton";
import { PosField } from "./ui/PosField";
import "./settings-hub.css";

type ExtendedPosApi = typeof window.raspechatkaPos;
const pos = () => window.raspechatkaPos as ExtendedPosApi;
export async function saveConnectionWithConfigurationRefresh(
  api: Pick<ExtendedPosApi, "saveConnection" | "syncConfiguration">,
  config: ConnectionConfig
): Promise<BootState> {
  await api.saveConnection(config);
  return api.syncConfiguration();
}

export const SETTINGS_OPEN_TRIGGER_CLASS = "settings-open-trigger";
export const SETTINGS_OPEN_TRIGGER_SELECTOR = "." + SETTINGS_OPEN_TRIGGER_CLASS;

export type SettingsGateState = {
  gateOpen: boolean;
  open: boolean;
  gateError: string;
};

export const settingsGateStateAfterVerification = (verified: boolean): SettingsGateState =>
  verified
    ? { gateOpen: false, open: true, gateError: "" }
    : { gateOpen: true, open: false, gateError: "Неверный пароль" };

export async function resolveSettingsAdminGate(
  password: string,
  verify: (password: string) => Promise<boolean>
): Promise<SettingsGateState> {
  return settingsGateStateAfterVerification(await verify(password));
}

export function SettingsAdminGate({
  password,
  error,
  onPasswordChange,
  onCancel,
  onSubmit,
}: {
  password: string;
  error: string;
  onPasswordChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="settings-gate-backdrop">
      <form
        className="settings-gate"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <PinEntryLayout
          footerLeft={
            <PosButton type="button" onClick={onCancel}>
              Отмена
            </PosButton>
          }
          footerRight={
            <PosButton variant="primary" type="submit">
              Войти
            </PosButton>
          }
        >
          <div className="settings-gate-content">
            <small>ЗАЩИЩЁННЫЙ РАЗДЕЛ</small>
            <h2>Настройки кассы</h2>
            <p>Введите пароль администратора.</p>
            <PinInput
              autoFocus
              value={password}
              onChange={onPasswordChange}
              ariaLabel="Пароль администратора · 4 цифры"
            />
            {error && <div className="settings-error">{error}</div>}
          </div>
        </PinEntryLayout>
      </form>
    </div>
  );
}

export type SettingsHubProps = {
  initialGateOpen?: boolean;
  initialOpen?: boolean;
};

const channelState=(status:DeviceStatuses['os'],ready:string,offline:string)=>
  status.status==='ready'?ready:
  status.status==='unknown'?'Нет данных':
  status.status==='not_available'?'Недоступно':
  status.status==='not_configured'?'Не настроено':
  status.status==='busy'?'Занято':offline;

export const buildSettingsStatusItems = (devices: DeviceStatuses | null) =>
  devices
    ? ([
        ['OS',devices.os.ready,channelState(devices.os,'На связи','Локальный режим'),devices.os.status],
        ['ККТ и ФН',devices.fiscal.ready,channelState(devices.fiscal,'Готовы','Требуют проверки'),devices.fiscal.status],
        ['Передача в ОФД',devices.ofd.ready,channelState(devices.ofd,'На связи','Задержка передачи'),devices.ofd.status],
        ['Эквайринг',devices.payment.ready,channelState(devices.payment,'Готов','Нет связи'),devices.payment.status],
        ['Удалённая оплата',devices.remotePayment.ready,channelState(devices.remotePayment,'Доступна','Нет связи с OS'),devices.remotePayment.status],
        ['Принтер',devices.printer.ready,channelState(devices.printer,'Готов','Требует проверки'),devices.printer.status],
      ] as const)
    : [];

const queueState=(item:SyncQueueItem,now=Date.now())=>
  item.status==='problem'?'Требует исправления':
  item.nextAttemptAt&&Date.parse(item.nextAttemptAt)>now?'Ожидает повторной отправки':'Ожидает отправки';

export function SettingsSyncQueue({queue,busy,onRetry}:{queue:SyncQueueSnapshot|null;busy:boolean;onRetry:(id:string)=>void}){
  const syncQueue=queue;
  return (
              <section className="settings-section">
                <div className="section-heading">
                  <h2>Очередь синхронизации</h2>
                  <b>{syncQueue?.total ?? '—'}</b>
                </div>
                {syncQueue?.total===0 ? <div className="settings-ok">Все документы отправлены.</div>
                  : <>
                    <div className="settings-queue-summary">
                      {syncQueue ? `Ожидают: ${syncQueue.total - syncQueue.problemCount} · Требуют исправления: ${syncQueue.problemCount}${syncQueue.problemCountTruncated ? '+' : ''}` : 'Загрузка очереди…'}
                    </div>
                    <div className="settings-sync-list">
                      {syncQueue?.items.map((item)=><article key={item.id}>
                        <div>
                          <b>{item.label}</b>
                          <span>{new Date(item.createdAt).toLocaleString('ru-RU')} · {queueState(item)} · Попыток: {item.attemptCount}</span>
                          {item.lastError&&<span>{item.lastError}</span>}
                        </div>
                        {item.canRetry&&<PosButton disabled={busy} onClick={()=>onRetry(item.id)}>Повторить отправку</PosButton>}
                      </article>)}
                    </div>
                    {syncQueue&&syncQueue.total>syncQueue.items.length&&<div className="settings-warning">Показана часть очереди. Остальные документы ожидают отправки.</div>}
                  </>}
              </section>
  );
}

const defaultAtol: AtolSettings = {
  version: 2,
  enabled: false,
  adapter: "driver",
  taxationType: "patent",
  taxType: "none",
  direct: {},
  web: { baseUrl: "http://127.0.0.1:16732/api/v2" },
};
const defaultInpas: InpasSettings = {
  enabled: false,
  executablePath: "",
  terminalId: "",
  currencyCode: "643",
  timeoutMs: 3600000,
  qrMode: "terminal_choice",
};

export default function SettingsHub({ initialGateOpen = false, initialOpen = false }: SettingsHubProps = {}) {
  const [gateOpen, setGateOpen] = useState(initialGateOpen);
  const [open, setOpen] = useState(initialOpen);
  const [password, setPassword] = useState("");
  const [gateError, setGateError] = useState("");
  const [boot, setBoot] = useState<BootState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [devices, setDevices] = useState<DeviceStatuses | null>(null);
  const [atol, setAtol] = useState<AtolSettings>(defaultAtol);
  const [atolDriver, setAtolDriver] = useState<AtolDriverInfo | null>(null);
  const [atolDevices, setAtolDevices] = useState<AtolDriverDevice[]>([]);
  const [atolStatus, setAtolStatus] = useState<AtolDriverStatus | null>(null);
  const [inpas, setInpas] = useState<InpasSettings>(defaultInpas);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printer, setPrinter] = useState("");
  const [operations, setOperations] = useState<UnresolvedOperation[]>([]);
  const [printJobs, setPrintJobs] = useState<PrintJobSummary[]>([]);
  const [syncQueue, setSyncQueue] = useState<SyncQueueSnapshot | null>(null);
  const [posVersion, setPosVersion] = useState("");
  const [adminCode, setAdminCode] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);
  const [pairing, setPairing] = useState<ConnectionConfig>({
    serverUrl: "https://os.rpechatka.ru",
    deviceId: "",
    token: "",
  });
  const [showPairing, setShowPairing] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        SETTINGS_OPEN_TRIGGER_SELECTOR
      );
      if (!trigger) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setPassword("");
      setGateError("");
      setOpen(false);
      setGateOpen(true);
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);

  const refresh = async () => {
    const [
      nextBoot,
      nextConnection,
      nextDevices,
      nextAtol,
      nextInpas,
      nextPrinters,
      nextPrinter,
      nextOperations,
      nextPrintJobs,
      nextDiagnostics,
      nextAtolDriver,
    ] = await Promise.all([
      pos().getBootState(),
      pos().getConnectionStatus(),
      pos().getDeviceStatuses(),
      pos().getAtolSettings(),
      pos().getInpasSettings(),
      pos().listPrinters(),
      pos().getSelectedPrinter(),
      pos().listUnresolvedOperations(),
      pos().listPrintJobs(),
      pos().listDiagnosticEvents(80),
      pos().getAtolDriverInfo().catch((error) => ({
        installed: false,
        error: error instanceof Error ? error.message : String(error),
      })),
    ]);
    setBoot(nextBoot);
    setConnection(nextConnection);
    setDevices(nextDevices);
    setAtol(nextAtol);
    setInpas(nextInpas);
    setPrinters(nextPrinters);
    setPrinter(nextPrinter || "");
    setOperations(nextOperations);
    setPrintJobs(nextPrintJobs);
    setDiagnostics(nextDiagnostics);
    setAtolDriver(nextAtolDriver);
    setSyncQueue(nextSyncQueue);
    setPosVersion(nextPosVersion);
    setPairing((current) => ({
      ...current,
      serverUrl: nextConnection.serverUrl || current.serverUrl,
      deviceId: nextConnection.deviceId || current.deviceId,
      token: "",
    }));
  };

  useEffect(() => {
    if (!open) return;
    void refresh().catch((error) =>
      setMessage(error instanceof Error ? error.message : String(error))
    );
    const timer = window.setInterval(
      () => void refresh().catch(() => undefined),
      10000
    );
    return () => window.clearInterval(timer);
  }, [open]);

  const unlock = async () => {
    const next = await resolveSettingsAdminGate(
      password,
      (code) => pos().verifyAdminCode(code)
    );
    setGateOpen(next.gateOpen);
    setOpen(next.open);
    setGateError(next.gateError);
    if (!next.open) return;
    setAdminCode(password);
    setPassword("");
    void refresh();
  };
  const close = () => {
    setOpen(false);
    setAdminCode("");
    setShowPairing(false);
    setMessage("");
  };

  const saveConnection = async () => {
    setBusy(true);
    setMessage("Проверяем подключение к Распечатка OS…");
    try {
      const next = await saveConnectionWithConfigurationRefresh(pos(), pairing);
      setBoot(next);
      setShowPairing(false);
      setPairing((x) => ({ ...x, token: "" }));
      await refresh();
      setMessage("Касса подключена к точке " + next.pointName);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const syncConfiguration = async () => {
    setBusy(true);
    setMessage("Обновляем конфигурацию и справочники…");
    try {
      const next = await pos().syncConfiguration();
      setBoot(next);
      await refresh();
      setMessage("Конфигурация и справочники обновлены");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const refreshAtolDevices = async () => {
    try {
      const found = await pos().discoverAtolDevices();
      setAtolDevices(found);
      setMessage(found.length ? "ККТ АТОЛ найдены" : "ККТ АТОЛ не найдены");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const saveAtol = async () => {
    try {
      const selected = atol.direct?.selectedDevice;
      if (!selected) throw new Error("Выберите найденную ККТ АТОЛ");
      await pos().selectAtolDevice(selected);
      setAtol(await pos().saveAtolSettings({ ...atol, adapter: "driver" }));
      setMessage("ККТ АТОЛ сохранена по серийному номеру");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const testAtol = async () => {
    try {
      setAtolStatus(await pos().testAtolDriverDevice());
      setMessage("Связь с выбранной ККТ проверена");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const saveInpas = async () => {
    try {
      setInpas(await pos().saveInpasSettings(inpas));
      setMessage("Настройки INPAS сохранены");
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const selectPrinter = async (name: string) => {
    try {
      await pos().setSelectedPrinter(name);
      setPrinter(name);
      setMessage("Принтер сохранён");
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const terminal = async (kind: "test" | "reconcile") => {
    try {
      const result =
        kind === "test"
          ? await pos().testPaymentTerminal()
          : await pos().reconcilePaymentTerminal();
      setMessage(result.message);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const recover = async (id: string) => {
    try {
      const result = await pos().recoverOperation(id);
      setMessage(result.message);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const retryPrint = async (id: string) => {
    try {
      const result = await pos().retryPrintJob(id);
      setMessage(result.message);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const retrySyncEvent = async (id:string) => {
    if(!adminCode)return setMessage('Войдите как администратор повторно')
    setBusy(true)
    try {
      const result=await pos().retrySyncEvent(id,adminCode)
      await refresh()
      setMessage(result.message)
    } catch {
      await refresh().catch(()=>undefined)
      setMessage('Повтор не завершён. Проверьте состояние документа в очереди')
    } finally {setBusy(false)}
  };

  const statusItems = useMemo(() => buildSettingsStatusItems(devices), [devices]);

  return (
    <>
      {gateOpen && (
        <SettingsAdminGate
          password={password}
          error={gateError}
          onPasswordChange={setPassword}
          onCancel={() => setGateOpen(false)}
          onSubmit={() => void unlock()}
        />
      )}

      {open && (
        <div className="settings-hub">
          <header className="settings-hub-header">
            <div>
              <small>ТЕХНИЧЕСКИЙ РАЗДЕЛ</small>
              <h1>Настройки кассы</h1>
            </div>
            <PosIconButton icon="close" label="Закрыть настройки" onClick={close}/>
          </header>
          <div className="settings-hub-body">
            <section className="settings-section status-section">
              <div className="section-heading">
                <div>
                  <h2>Состояние кассы</h2>
                </div>
                <PosButton onClick={() => void refresh()}>Обновить</PosButton>
              </div>
              <div className="settings-status-grid">
                {statusItems.map(([label, ready, text, status]) => (
                  <article key={label} className={ready ? "ready" : status==="unknown"||status==="not_available" ? "neutral" : "bad"}>
                    <i aria-hidden="true" />
                    <div>
                      <b>{label}</b>
                      <span>{text}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h2>Распечатка OS и точка</h2>
                </div>
                {connection?.configured && (
                  <PosButton onClick={() => setShowPairing((x) => !x)}>
                    {showPairing ? "Отмена" : "Переподключить"}
                  </PosButton>
                )}
              </div>
              {connection?.configured && !showPairing ? (
                <div className="connection-summary">
                  <div>
                    <small>СТАТУС</small>
                    <b>{boot?.online ? "На связи" : "Локальный режим"}</b>
                  </div>
                  <div>
                    <small>ТОЧКА</small>
                    <b>
                      {boot?.source === "frappe"
                        ? boot.pointName
                        : "Ожидает синхронизации"}
                    </b>
                  </div>
                  <div>
                    <small>РАБОЧЕЕ МЕСТО</small>
                    <b>{boot?.workstationName || "—"}</b>
                  </div>
                  <div>
                    <small>DEVICE ID</small>
                    <b>{connection.deviceId || "—"}</b>
                  </div>
                  <div>
                    <small>СОТРУДНИК</small>
                    <b>{boot?.cashierName ? formatPersonShortName(boot.cashierName) : "Не выбран"}</b>
                  </div>
                  <div>
                    <small>ПОСЛЕДНЯЯ СИНХРОНИЗАЦИЯ</small>
                    <b>
                      {boot?.lastSyncAt
                        ? new Date(boot.lastSyncAt).toLocaleString("ru-RU")
                        : "Ещё не было"}
                    </b>
                  </div>
                  <div>
                    <small>ОЧЕРЕДЬ</small>
                    <b>{boot?.pendingSync || 0}</b>
                  </div>
                </div>
              ) : (
                <div className="settings-form-grid">
                  <PosField label="Адрес OS"><input
                      value={pairing.serverUrl}
                      onChange={(e) =>
                        setPairing({ ...pairing, serverUrl: e.target.value })
                      }
                    /></PosField>
                  <PosField label="Device ID"><input
                      value={pairing.deviceId || ""}
                      onChange={(e) =>
                        setPairing({ ...pairing, deviceId: e.target.value })
                      }
                      placeholder="POS-…"
                    /></PosField>
                  <PosField label="Token" className="settings-full"><input
                      type="password"
                      value={pairing.token || ""}
                      onChange={(e) =>
                        setPairing({ ...pairing, token: e.target.value })
                      }
                      placeholder="Показывается в OS один раз"
                      autoComplete="new-password"
                    /></PosField>
                  <PosButton
                    variant="primary" className="settings-full"
                    disabled={
                      busy ||
                      !pairing.deviceId?.trim() ||
                      !pairing.token?.trim()
                    }
                    onClick={() => void saveConnection()}
                  >
                    Подключить кассу
                  </PosButton>
                </div>
              )}
              {boot?.employees.length ? (
                <div className="cashier-row">
                  <span>
                    Подтверждённых кассиров точки:{" "}
                    <b>{boot.employees.length}</b>
                  </span>
                  <PosButton
                    disabled={busy || !connection?.configured}
                    onClick={() => void syncConfiguration()}
                  >
                    Обновить конфигурацию
                  </PosButton>
                </div>
              ) : (
                connection?.configured && (
                  <div className="settings-warning">
                    К этой точке не прикреплены активные сотрудники.
                  </div>
                )
              )}
              {connection?.lastError && (
                <div className="settings-error">{connection.lastError}</div>
              )}
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h2>ККТ АТОЛ</h2>
                  
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={atol.enabled}
                    onChange={(e) => setAtol({ ...atol, enabled: e.target.checked })} /> Использовать АТОЛ
                </label>
              </div>
              <div className="settings-form-grid">
                <label><span>Драйвер ККТ 10</span><strong className={atolDriver?.installed ? "settings-indicator ready" : "settings-indicator warning"}>{atolDriver?.installed ? `Найден${atolDriver.version ? ` · ${atolDriver.version}` : ""}` : `${atolDriver?.error || "Не найден"}`}</strong></label>
                <PosField label="ККТ"><select value={atol.direct?.selectedDevice?.serialNumber || ""}
                    onChange={(e) => {
                      const device = atolDevices.find((x) => x.serialNumber === e.target.value);
                      if (device) setAtol({ ...atol, adapter: "driver", direct: { selectedDevice: {
                        serialNumber: device.serialNumber, modelName: device.modelName,
                        connection: device.connection, settingsJson: device.settingsJson,
                      } } });
                    }}>
                    <option value="">Выберите найденную ККТ</option>
                    {atolDevices.map((device) => <option key={device.serialNumber} value={device.serialNumber}>
                      {device.modelName} · {device.serialNumber} · {device.connection.toUpperCase()}
                    </option>)}
                  </select></PosField>
                <PosField label="СНО"><select value={atol.taxationType} onChange={(e) => setAtol({ ...atol, taxationType: e.target.value })}>
                  <option value="patent">Патент</option><option value="usnIncome">УСН доход</option><option value="usnIncomeOutcome">УСН доход − расход</option><option value="osn">ОСН</option>
                </select></PosField>
                <PosField label="НДС"><select value={atol.taxType} onChange={(e) => setAtol({ ...atol, taxType: e.target.value })}>
                  <option value="none">Без НДС</option><option value="vat0">0%</option><option value="vat5">5%</option><option value="vat7">7%</option><option value="vat10">10%</option><option value="vat20">20%</option><option value="vat22">22%</option>
                </select></PosField>
                {atolStatus && <label><span>Статус ККТ</span><strong>{atolStatus.connected ? `Подключена · смена: ${atolStatus.shiftState ?? "неизвестно"}` : atolStatus.errorDescription || "Нет связи"}</strong></label>}
              </div>
              <div className="settings-actions">
                <PosButton onClick={() => void refreshAtolDevices()}>Обновить</PosButton>
                <PosButton variant="primary" onClick={() => void saveAtol()}>Подключить / сохранить</PosButton>
                <PosButton onClick={() => void testAtol()}>Проверить связь</PosButton>
              </div>
            </section>
            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h2>Эквайринг INPAS / PAX</h2>
                  
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={inpas.enabled}
                    onChange={(e) =>
                      setInpas({ ...inpas, enabled: e.target.checked })
                    }
                  />{" "}
                  Использовать INPAS
                </label>
              </div>
              <div className="settings-form-grid">
                <label>
                  <span>Dual Connector</span>
                  <strong className={devices?.payment.ready ? "settings-indicator ready" : inpas.enabled ? "settings-indicator warning" : "settings-indicator"}>{devices?.payment.ready ? "Найден и подключён" : inpas.enabled ? "Нет связи" : "Выключен"}</strong>
                </label>
                <PosField label="ID терминала"><input
                    value={inpas.terminalId}
                    onChange={(e) =>
                      setInpas({ ...inpas, terminalId: e.target.value })
                    }
                  /></PosField>
                <PosField label="Код валюты"><input value={inpas.currencyCode} readOnly /></PosField>
                <PosField label="Таймаут, сек."><input
                    type="number"
                    min="30"
                    max="3600"
                    value={Math.round(inpas.timeoutMs / 1000)}
                    onChange={(e) =>
                      setInpas({
                        ...inpas,
                        timeoutMs: Number(e.target.value) * 1000,
                      })
                    }
                  /></PosField>
              </div>
              <div className="settings-actions">
                <PosButton variant="primary" onClick={() => void saveInpas()}>
                  Сохранить INPAS
                </PosButton>
                <PosButton onClick={() => void terminal("test")}>
                  Проверить связь
                </PosButton>
                <PosButton onClick={() => void terminal("reconcile")}>
                  Сверка итогов
                </PosButton>
              </div>
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h2>Принтер товарного чека</h2>
                  
                </div>
              </div>
              <PosField label="Принтер" className="printer-row"><select
                  value={printer}
                  onChange={(e) => void selectPrinter(e.target.value)}
                >
                  <option value="">Не выбран</option>
                  {printers.map((x) => (
                    <option key={x.name} value={x.name}>
                      {x.name}
                      {x.isDefault ? " · по умолчанию" : ""}
                    </option>
                  ))}
                </select></PosField>
            </section>

            <SettingsSyncQueue queue={syncQueue} busy={busy} onRetry={(id)=>void retrySyncEvent(id)}/>

            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h2>Незавершённые операции</h2>
                </div>
                <b>{operations.length + printJobs.length}</b>
              </div>
              {!operations.length && !printJobs.length ? (
                <div className="settings-ok">
                  Нет операций, требующих восстановления.
                </div>
              ) : (
                <div className="settings-recovery-list">
                  {operations.map((x) => (
                    <article key={x.id}>
                      <div>
                        <b>
                          {x.kind === "sale" ? "Продажа" : "Возврат"} ·{" "}
                          {x.state}
                        </b>
                        <span>
                          {x.lastError || "Операция сохранена локально"}
                        </span>
                      </div>
                      <PosButton onClick={() => void recover(x.id)}>
                        Проверить и продолжить
                      </PosButton>
                    </article>
                  ))}
                  {printJobs.map((x) => (
                    <article key={x.id}>
                      <div>
                        <b>Товарный чек · {x.state}</b>
                        <span>{x.lastError || "Ожидает печати"}</span>
                      </div>
                      <PosButton onClick={() => void retryPrint(x.id)}>
                        Повторить печать
                      </PosButton>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h2>Диагностика</h2>
                  
                </div>
                <PosButton onClick={() => void refresh()}>Обновить</PosButton>
              </div>
              <div className="settings-diagnostics-summary">
                <div><small>Версии</small><b>POS {posVersion || '—'} · АТОЛ {atolDriver?.version || '—'} · INPAS {String(devices?.payment.details?.version || '—')}</b></div>
                <div><small>Провайдеры</small><b>ККТ: {atol.adapter} · Терминал: {inpas.enabled ? 'включён' : 'выключен'}</b></div>
                <div><small>Последняя связь с OS</small><b>{boot?.lastSyncAt ? new Date(boot.lastSyncAt).toLocaleString('ru-RU') : 'Ещё не было'}</b></div>
                <div><small>Очередь</small><b>Всего: {syncQueue?.total ?? '—'} · Проблем: {syncQueue?.problemCount ?? '—'}{syncQueue?.problemCountTruncated ? '+' : ''}</b></div>
              </div>
              <details className="settings-technical-details"><summary>Техническое состояние каналов и проблемных событий</summary>
                <pre>{JSON.stringify({devices,problems:syncQueue?.items.filter((x)=>x.status==='problem').map((x)=>({id:x.id,eventType:x.eventType,error:x.lastError}))},null,2)}</pre>
              </details>
              <div className="settings-log">
                {diagnostics.length ? (
                  diagnostics.slice(0, 40).map((x) => (
                    <article key={x.id} className={x.level}>
                      <time>
                        {new Date(x.createdAt).toLocaleString("ru-RU")}
                      </time>
                      <div>
                        <b>
                          {x.source} · {x.eventType}
                        </b>
                        <span>{x.message}</span>
                        {(x.operationId||x.details)&&<details><summary>Технические данные</summary><pre>{JSON.stringify({id:x.id,operationId:x.operationId,details:x.details},null,2)}</pre></details>}
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="settings-ok">
                    Диагностических событий пока нет.
                  </div>
                )}
              </div>
            </section>
            {message && <div className="settings-message">{message}</div>}
          </div>
        </div>
      )}
    </>
  );
}
