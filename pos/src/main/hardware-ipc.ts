import { ipcMain } from "electron";
import type { InpasDirectDevice, InpasSettings } from "../shared/contracts";
import type { PosDiagnostics } from "./diagnostics";
import type { AtolSettings, AtolSettingsStore } from "./providers/atol-settings";
import { NativeAtolDriverBridge, resolveAtolBridgeExecutablePath } from "./providers/atol-driver-bridge";
import type { AtolDriverBridge, AtolDriverInfo } from "./providers/atol-driver";
import type { AtolWebManager } from "./atol-web-manager";
import type { FiscalProvider } from "./providers/contracts";
import type { InpasPaymentProvider } from "./providers/inpas";
import {
  collectInpasTerminalCandidates,
  InpasSettingsStore,
  isNumericTerminalId,
} from "./providers/inpas-settings";
import {
  NativeInpasBridge,
  type InpasDirectBridge,
} from "./providers/inpas-direct-bridge";

function atolErrorDetails(error: unknown): Record<string, unknown> {
  const value = error as {
    code?: unknown; driverErrorCode?: unknown; driverErrorDescription?: unknown;
  };
  return {
    errorCode: value?.driverErrorCode ?? value?.code,
    errorDescription: value?.driverErrorDescription ??
      (error instanceof Error ? error.message : String(error)),
  };
}

export function registerHardwareSettingsIpc(
  atolSettingsStore: AtolSettingsStore,
  atolManager: AtolWebManager | undefined,
  fiscalProvider: FiscalProvider | undefined,
  inpasSettingsStore: InpasSettingsStore,
  paymentProvider: InpasPaymentProvider | undefined,
  diagnostics: PosDiagnostics,
  driverBridge: AtolDriverBridge = new NativeAtolDriverBridge({
    executablePath:
      resolveAtolBridgeExecutablePath(),
  }),
  hasBlockingFiscalOperation: () => boolean = () => false,
  inpasBridge: InpasDirectBridge = new NativeInpasBridge({
    executablePath: process.env.RASPECHATKA_INPAS_BRIDGE_PATH ?? "Raspechatka.InpasBridge.exe",
  }),
  hasBlockingPaymentOperation: () => boolean = () => false,
  inpasResultDirectory?: string
): void {
  ipcMain.handle("pos:get-atol-settings", () => atolSettingsStore.load());
  ipcMain.handle(
    "pos:save-atol-settings",
    async (_event, value: Partial<AtolSettings> & { configureDevice?: boolean }) => {
      const { configureDevice, ...settings } = value;
      const current = atolSettingsStore.load();
      const currentDevice = current.direct?.selectedDevice;
      const nextAdapter = settings.adapter ?? current.adapter;
      const nextDevice = settings.direct?.selectedDevice ?? currentDevice;
      const deviceChanged = JSON.stringify(nextDevice ?? null) !== JSON.stringify(currentDevice ?? null);
      if (hasBlockingFiscalOperation() && (nextAdapter !== current.adapter || deviceChanged)) {
        throw new Error("Нельзя менять адаптер или настройки ККТ: есть незавершённая фискальная операция");
      }
      const saved = atolSettingsStore.save(settings);
      if (saved.adapter === "driver") {
        return saved;
      }

      if (saved.enabled) {
        await atolManager?.ensureReady();
        if (configureDevice) {
          if (!atolManager)
            throw new Error("Настройка реального АТОЛ недоступна в учебном режиме");
          await atolManager.configureAtol1F();
          diagnostics.record({
            source: "fiscal",
            eventType: "atol.device_configured",
            message: "АТОЛ 1Ф добавлен в Web Requests и активирован",
          });
        }
        const health = await fiscalProvider?.healthCheck();
        if (health && !health.ready) throw new Error(health.message);
      }
      return saved;
    }
  );

  ipcMain.handle("pos:get-atol-driver-info", async (): Promise<AtolDriverInfo> => {
    try {
      const info = await driverBridge.getDriverInfo();
      diagnostics.record({
        source: "fiscal",
        level: info.installed ? "info" : "warning",
        eventType: info.installed ? "atol.driver.detected" : "atol.driver.missing",
        message: info.installed ? "Обнаружен Драйвер ККТ 10" : "Драйвер ККТ 10 недоступен",
        details: {
          driverVersion: info.version,
          architecture: info.architecture,
          errorCode: info.code,
          errorDescription: info.error,
        },
      });
      return info;
    } catch (error) {
      diagnostics.record({
        source: "fiscal",
        level: "warning",
        eventType: "atol.driver.missing",
        message: "ATOL bridge или Драйвер ККТ 10 недоступен",
        details: atolErrorDetails(error),
      });
      throw error;
    }
  });
  ipcMain.handle("pos:discover-atol-devices", async () => {
    try {
      const devices = (await driverBridge.findDevices()).flatMap((device) =>
        device.serialNumber && device.settingsJson
          ? [{
              id: device.id,
              serialNumber: device.serialNumber,
              modelName: device.modelName,
              firmwareVersion: device.firmwareVersion,
              connection: device.connection === "usb" || device.connection === "com" || device.connection === "tcp"
                ? device.connection
                : "usb",
              settingsJson: device.settingsJson,
            }]
          : []
      );
      diagnostics.record({
        source: "fiscal",
        eventType: "atol.device.discovered",
        message: `Драйвер ККТ 10 обнаружил ККТ: ${devices.length}`,
        details: {
          devices: devices.map((device) => ({
            serial: device.serialNumber,
            model: device.modelName,
            firmware: device.firmwareVersion,
            connection: device.connection,
          })),
        },
      });
      return devices;
    } catch (error) {
      diagnostics.record({
        source: "fiscal",
        level: "warning",
        eventType: "atol.device.connection_lost",
        message: "Не удалось обнаружить ККТ АТОЛ",
        details: atolErrorDetails(error),
      });
      throw error;
    }
  });
  ipcMain.handle("pos:select-atol-device", (_event, selectedDevice) => {
    if (
      !selectedDevice ||
      typeof selectedDevice.serialNumber !== "string" ||
      typeof selectedDevice.modelName !== "string" ||
      typeof selectedDevice.settingsJson !== "string" ||
      !["usb", "com", "tcp"].includes(selectedDevice.connection)
    ) {
      throw new Error("Выберите ККТ, найденную Драйвером ККТ 10");
    }
    const currentDevice = atolSettingsStore.load().direct?.selectedDevice;
    const selectedChanged = JSON.stringify(currentDevice ?? null) !== JSON.stringify({
      serialNumber: selectedDevice.serialNumber,
      modelName: selectedDevice.modelName,
      connection: selectedDevice.connection,
      settingsJson: selectedDevice.settingsJson,
    });
    if (selectedChanged && hasBlockingFiscalOperation()) {
      throw new Error("Нельзя менять ККТ: есть незавершённая фискальная операция");
    }
    const saved = atolSettingsStore.save({
      adapter: "driver",
      direct: {
        selectedDevice: {
          serialNumber: selectedDevice.serialNumber,
          modelName: selectedDevice.modelName,
          connection: selectedDevice.connection,
          settingsJson: selectedDevice.settingsJson,
        },
      },
    });
    diagnostics.record({
      source: "fiscal",
      eventType: "atol.device.selected",
      message: "Выбрана ККТ АТОЛ для прямого подключения",
      details: {
        serial: selectedDevice.serialNumber,
        model: selectedDevice.modelName,
        connection: selectedDevice.connection,
      },
    });
    return saved;
  });
  ipcMain.handle("pos:test-atol-driver-device", async () => {
    const selectedDevice = atolSettingsStore.load().direct?.selectedDevice;
    if (!selectedDevice)
      throw new Error("Сначала выберите ККТ АТОЛ по серийному номеру");

    try {
      await driverBridge.connect({
        id: `atol:${selectedDevice.serialNumber}`,
        modelName: selectedDevice.modelName,
        serialNumber: selectedDevice.serialNumber,
        connection: selectedDevice.connection,
        settingsJson: selectedDevice.settingsJson,
      });
      const status = await driverBridge.getStatus();
      diagnostics.record({
        source: "fiscal",
        eventType: "atol.device.connected",
        message: `Подключена ККТ АТОЛ ${status.serialNumber ?? selectedDevice.serialNumber}`,
        details: {
          serial: status.serialNumber ?? selectedDevice.serialNumber,
          model: status.modelName ?? selectedDevice.modelName,
          firmware: status.firmwareVersion,
          shift: status.shiftState,
          driverVersion: status.driverVersion,
        },
      });
      return status;
    } catch (error) {
      diagnostics.record({
        source: "fiscal",
        level: "warning",
        eventType: "atol.device.connection_lost",
        message: "Связь с выбранной ККТ АТОЛ не подтверждена",
        details: { serial: selectedDevice.serialNumber, ...atolErrorDetails(error) },
      });
      throw error;
    } finally {
      await driverBridge.disconnect().catch(() => undefined);
    }
  });

  ipcMain.handle("pos:get-inpas-settings", () => inpasSettingsStore.load());
  ipcMain.handle("pos:save-inpas-settings", async (_event, value: InpasSettings) => {
    const current = inpasSettingsStore.load();
    const nextAdapter = value.adapter ?? current.adapter;
    const nextDevice = value.direct?.selectedDevice ?? current.direct?.selectedDevice;
    const nextConsoleTerminalId = value.console?.terminalId ?? current.console.terminalId;
    const changed = nextAdapter !== current.adapter ||
      JSON.stringify(nextDevice ?? null) !== JSON.stringify(current.direct?.selectedDevice ?? null) ||
      nextConsoleTerminalId !== current.console.terminalId;
    if (changed && hasBlockingPaymentOperation())
      throw new Error("Нельзя менять адаптер или терминал: есть незавершённая денежная операция");
    if (changed && nextAdapter === "direct" && nextDevice) {
      if (!isNumericTerminalId(nextDevice.terminalId))
        throw new Error("Выберите терминал, подтверждённый проверкой связи INPAS");
      const checked = await inpasBridge.testConnection(nextDevice.terminalId);
      if (!checked.success || checked.terminalId !== nextDevice.terminalId)
        throw new Error("Нельзя сохранить терминал: проверка связи не подтвердила его Terminal ID");
      value = {
        ...value,
        direct: {
          selectedDevice: {
            terminalId: checked.terminalId,
            model: checked.model ?? nextDevice.model,
            serial: checked.serial ?? nextDevice.serial,
          },
        },
      };
    }
    const saved = inpasSettingsStore.save(value);
    paymentProvider?.settingsChanged();
    diagnostics.record({
      source: "payment",
      eventType: "payment.settings_saved",
      message: saved.enabled ? "Настройки INPAS сохранены" : "Эквайринг INPAS выключен",
      details: { adapter: saved.adapter, terminalId: saved.direct?.selectedDevice?.terminalId },
    });
    return saved;
  });
  ipcMain.handle("pos:get-inpas-driver-info", () => inpasBridge.getDriverInfo());
  ipcMain.handle("pos:discover-inpas-devices", async () => {
    const driver = await inpasBridge.getDriverInfo();
    if (!driver.installed) {
      return {
        state: "driver_missing",
        message: "Установите или восстановите Интегратор Точки",
        devices: [],
        driver,
      };
    }
    const candidates = collectInpasTerminalCandidates(
      inpasSettingsStore.load(),
      inpasResultDirectory
    );
    if (!candidates.length) {
      return {
        state: "not_initialized",
        message: "INPAS установлен, терминал ещё не инициализирован. Выполните проверку связи в DC Control, затем нажмите Обновить",
        devices: [],
        driver,
      };
    }
    const devices: InpasDirectDevice[] = [];
    for (const terminalId of candidates) {
      try {
        const result = await inpasBridge.testConnection(terminalId);
        if (result.success && result.terminalId === terminalId) {
          devices.push({
            terminalId,
            model: result.model,
            serial: result.serial,
          });
        }
      } catch {
        // An unconfirmed candidate is never offered for selection.
      }
    }
    diagnostics.record({
      source: "payment",
      eventType: "inpas.device.discovered",
      message: `Найдено подтверждённых терминалов INPAS: ${devices.length}`,
      details: { terminals: devices },
    });
    return {
      state: devices.length ? "ready" : "not_initialized",
      message: devices.length
        ? "Терминал INPAS подтверждён операцией проверки связи"
        : "INPAS установлен, терминал ещё не инициализирован. Выполните проверку связи в DC Control, затем нажмите Обновить",
      devices,
      driver,
    };
  });
  ipcMain.handle("pos:select-inpas-device", async (_event, device: InpasDirectDevice) => {
    if (!device || !isNumericTerminalId(device.terminalId))
      throw new Error("Выберите терминал, подтверждённый проверкой связи INPAS");
    const current = inpasSettingsStore.load();
    const changed = current.adapter !== "direct" ||
      current.direct?.selectedDevice?.terminalId !== device.terminalId;
    if (changed && hasBlockingPaymentOperation())
      throw new Error("Нельзя менять терминал: есть незавершённая денежная операция");
    const checked = await inpasBridge.testConnection(device.terminalId);
    if (!checked.success || checked.terminalId !== device.terminalId)
      throw new Error("Нельзя сохранить терминал: проверка связи не подтвердила его Terminal ID");
    const saved = inpasSettingsStore.save({
      adapter: "direct",
      direct: { selectedDevice: {
        terminalId: checked.terminalId,
        model: checked.model ?? device.model,
        serial: checked.serial ?? device.serial,
      } },
    });
    diagnostics.record({
      source: "payment",
      eventType: "inpas.device.selected",
      message: "Выбран терминал Точка / INPAS",
      details: { terminalId: device.terminalId, model: device.model, serial: device.serial },
    });
    return saved;
  });
  ipcMain.handle("pos:test-inpas-direct-device", async () => {
    const selected = inpasSettingsStore.load().direct?.selectedDevice;
    if (!selected) throw new Error("Сначала выберите найденный терминал INPAS");
    const result = await inpasBridge.testConnection(selected.terminalId);
    if (!result.success || result.terminalId !== selected.terminalId)
      throw new Error("Проверка связи вернула другой или неподтверждённый Terminal ID");
    return result;
  });
  ipcMain.handle("pos:test-payment-terminal", async () => {
    if (!paymentProvider)
      throw new Error("В учебном режиме используется тестовый терминал");
    diagnostics.record({
      source: "payment",
      eventType: "payment.health_started",
      message: "Запущена проверка связи с INPAS / PAX",
    });
    try {
      const result = await paymentProvider.testConnection();
      diagnostics.record({
        source: "payment",
        eventType: "payment.health_completed",
        message: result.message,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.record({
        source: "payment",
        level: "error",
        eventType: "payment.health_failed",
        message,
      });
      throw error;
    }
  });
  ipcMain.handle("pos:reconcile-payment-terminal", async () => {
    if (inpasSettingsStore.load().adapter === "direct")
      throw new Error("Сверка итогов direct INPAS будет подключена вместе с платёжным provider; используйте DC Control");
    if (!paymentProvider)
      throw new Error("Сверка реального терминала недоступна в учебном режиме");
    diagnostics.record({
      source: "payment",
      eventType: "payment.reconcile_started",
      message: "Запущена сверка итогов INPAS",
    });
    try {
      const result = await paymentProvider.reconcile();
      diagnostics.record({
        source: "payment",
        eventType: "payment.reconcile_completed",
        message: result.message,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.record({
        source: "payment",
        level: "error",
        eventType: "payment.reconcile_failed",
        message,
      });
      throw error;
    }
  });
}
