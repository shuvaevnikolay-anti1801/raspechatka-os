import { ipcMain } from "electron";
import type { InpasSettings } from "../shared/contracts";
import type { PosDiagnostics } from "./diagnostics";
import type { AtolSettingsStore } from "./providers/atol-web";
import type { FiscalProvider } from "./providers/contracts";
import type { AtolDriverFiscalProvider } from "./providers/atol-driver";
import type {
  InpasPaymentProvider,
  InpasSettingsStore,
} from "./providers/inpas";

export function registerHardwareSettingsIpc(
  atolSettingsStore: AtolSettingsStore,
  _atolManager: unknown,
  fiscalProvider: FiscalProvider | undefined,
  inpasSettingsStore: InpasSettingsStore,
  paymentProvider: InpasPaymentProvider | undefined,
  diagnostics: PosDiagnostics
): void {
  const atolDriver = fiscalProvider as AtolDriverFiscalProvider | undefined;

  ipcMain.handle("pos:get-atol-settings", () => atolSettingsStore.load());

  ipcMain.handle("atol-driver:list-devices", async () => {
    if (!atolDriver || typeof atolDriver.listDevices !== "function") {
      throw new Error("Прямой драйвер АТОЛ недоступен");
    }
    return atolDriver.listDevices();
  });

  ipcMain.handle("atol-driver:connect", async (_event, device) => {
    if (!atolDriver || typeof atolDriver.connectDevice !== "function") {
      throw new Error("Прямой драйвер АТОЛ недоступен");
    }
    await atolDriver.connectDevice(device);
    return atolDriver.healthCheck();
  });

  ipcMain.handle("atol-driver:health", async () => {
    if (!fiscalProvider) {
      throw new Error("Фискальный провайдер недоступен");
    }
    return fiscalProvider.healthCheck();
  });

  ipcMain.handle("pos:save-atol-settings", (_event, value) => {
    return atolSettingsStore.save({
      ...value,
      baseUrl: "",
    });
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
}
