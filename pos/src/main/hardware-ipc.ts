import { ipcMain } from "electron";
import type { InpasSettings } from "../shared/contracts";
import type { PosDiagnostics } from "./diagnostics";
import type { AtolSettingsStore } from "./providers/atol-web";
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
  diagnostics: PosDiagnostics
): void {
  ipcMain.handle("pos:get-atol-settings", () => atolSettingsStore.load());
  ipcMain.handle(
    "pos:save-atol-settings",
    async (
      _event,
      value: {
        enabled: boolean;
        baseUrl: string;
        taxationType: string;
        taxType: string;
      }
    ) => {
      const saved = atolSettingsStore.save({
        ...value,
        baseUrl: "http://127.0.0.1:16732/api/v2",
      });
      if (saved.enabled) {
        await atolManager?.ensureReady();
        const health = await fiscalProvider?.healthCheck();
        if (health && !health.ready) throw new Error(health.message);
      }
      return saved;
    }
  );
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
