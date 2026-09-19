import { ipcMain } from "electron";
import type { InpasSettings } from "../shared/contracts";
import type { PosDiagnostics } from "./diagnostics";
import type { AtolSettings, AtolSettingsStore } from "./providers/atol-settings";
import { NativeAtolDriverBridge } from "./providers/atol-driver-bridge";
import type { AtolDriverBridge, AtolDriverInfo } from "./providers/atol-driver";
import type { AtolWebManager } from "./atol-web-manager";
import type { FiscalProvider } from "./providers/contracts";
import type {
  InpasPaymentProvider,
  InpasSettingsStore,
} from "./providers/inpas";

export function registerHardwareSettingsIpc(
  atolSettingsStore: AtolSettingsStore,
  atolManager: AtolWebManager | undefined,
  fiscalProvider: FiscalProvider | undefined,
  inpasSettingsStore: InpasSettingsStore,
  paymentProvider: InpasPaymentProvider | undefined,
  diagnostics: PosDiagnostics,
  driverBridge: AtolDriverBridge = new NativeAtolDriverBridge({
    executablePath:
      process.env.RASPECHATKA_ATOL_BRIDGE_PATH ?? "Raspechatka.AtolBridge.exe",
  }),
  hasBlockingFiscalOperation: () => boolean = () => false
): void {
  ipcMain.handle("pos:get-atol-settings", () => atolSettingsStore.load());
  ipcMain.handle(
    "pos:save-atol-settings",
    async (_event, value: Partial<AtolSettings> & { configureDevice?: boolean }) => {
      const { configureDevice, ...settings } = value;
      const currentSerial = atolSettingsStore.load().direct?.selectedDevice?.serialNumber;
      const nextSerial = settings.direct?.selectedDevice?.serialNumber;
      if (nextSerial && currentSerial !== nextSerial && hasBlockingFiscalOperation()) {
        throw new Error("Нельзя выбрать другую ККТ: есть незавершённая фискальная операция");
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

  ipcMain.handle("pos:get-atol-driver-info", async (): Promise<AtolDriverInfo> =>
    driverBridge.getDriverInfo()
  );
  ipcMain.handle("pos:discover-atol-devices", async () =>
    (await driverBridge.findDevices()).flatMap((device) =>
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
    )
  );
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
    const currentSerial = atolSettingsStore.load().direct?.selectedDevice?.serialNumber;
    if (currentSerial !== selectedDevice.serialNumber && hasBlockingFiscalOperation()) {
      throw new Error("Нельзя выбрать другую ККТ: есть незавершённая фискальная операция");
    }
    return atolSettingsStore.save({
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
        eventType: "atol.driver.connection_checked",
        message: `Проверена ККТ АТОЛ ${status.serialNumber ?? selectedDevice.serialNumber}`,
      });
      return status;
    } finally {
      await driverBridge.disconnect().catch(() => undefined);
    }
  });

  ipcMain.handle("pos:get-inpas-settings", () => inpasSettingsStore.load());
  ipcMain.handle("pos:save-inpas-settings", (_event, value: InpasSettings) => {
    const saved = inpasSettingsStore.save(value);
    paymentProvider?.settingsChanged();
    diagnostics.record({
      source: "payment",
      eventType: "payment.settings_saved",
      message: saved.enabled
        ? "Настройки INPAS сохранены"
        : "Эквайринг INPAS выключен",
    });
    return saved;
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
