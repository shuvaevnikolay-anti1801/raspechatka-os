import type { AtolWebManager } from "../atol-web-manager";
import { AtolDriverFiscalProvider, type AtolDriverBridge } from "./atol-driver";
import { NativeAtolDriverBridge } from "./atol-driver-bridge";
import type { FiscalProvider } from "./contracts";
import { MockFiscalProvider } from "./mock";
import type { AtolSettingsStore } from "./atol-settings";
import { AtolWebFiscalProvider } from "./atol-web";

export type FiscalProviderFactoryOptions = {
  trainingMode: boolean;
  settingsStore: AtolSettingsStore;
  webManager?: AtolWebManager;
  currentOperator: () => string | undefined;
  driverBridge?: AtolDriverBridge;
};

export function createFiscalProvider(
  options: FiscalProviderFactoryOptions
): FiscalProvider {
  if (options.trainingMode) return new MockFiscalProvider();

  const settings = options.settingsStore.load();
  if (settings.adapter === "web") {
    return new AtolWebFiscalProvider(
      options.settingsStore,
      options.webManager,
      options.currentOperator
    );
  }

  return new AtolDriverFiscalProvider(
    options.driverBridge ??
      new NativeAtolDriverBridge({
        executablePath:
          process.env.RASPECHATKA_ATOL_BRIDGE_PATH ??
          "Raspechatka.AtolBridge.exe",
      }),
    options.settingsStore,
    options.currentOperator
  );
}
