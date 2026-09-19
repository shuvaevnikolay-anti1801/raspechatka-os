import type { AtolWebManager } from "../atol-web-manager";
import { AtolDriverFiscalProvider, type AtolDriverBridge } from "./atol-driver";
import { NativeAtolDriverBridge, resolveAtolBridgeExecutablePath } from "./atol-driver-bridge";
import type { PosDiagnostics } from "../diagnostics";
import type { FiscalProvider, FiscalRecoverySnapshot } from "./contracts";
import { MockFiscalProvider } from "./mock";
import type { AtolSettingsStore } from "./atol-settings";
import { AtolWebFiscalProvider } from "./atol-web";

export type FiscalProviderFactoryOptions = {
  trainingMode: boolean;
  settingsStore: AtolSettingsStore;
  webManager?: AtolWebManager;
  currentOperator: () => string | undefined;
  driverBridge?: AtolDriverBridge;
  diagnostics?: PosDiagnostics;
};

export function createFiscalProvider(
  options: FiscalProviderFactoryOptions
): FiscalProvider {
  if (options.trainingMode) return new MockFiscalProvider();

  const web = new AtolWebFiscalProvider(
    options.settingsStore,
    options.webManager,
    options.currentOperator
  );
  const driver = new AtolDriverFiscalProvider(
    options.driverBridge ??
      new NativeAtolDriverBridge({
        executablePath: resolveAtolBridgeExecutablePath(),
      }),
    options.settingsStore,
    options.currentOperator,
    options.diagnostics
  );
  const current = (): FiscalProvider =>
    options.settingsStore.load().adapter === "web" ? web : driver;

  return {
    healthCheck: () => current().healthCheck(),
    getShiftStatus: () => current().getShiftStatus(),
    openShift: (operatorName) => current().openShift(operatorName),
    closeShift: (operatorName) => current().closeShift(operatorName),
    fiscalizeSale: (request) => current().fiscalizeSale(request),
    fiscalizeReturn: (request) => current().fiscalizeReturn(request),
    captureRecoverySnapshot: async (): Promise<FiscalRecoverySnapshot|undefined> =>
      current().captureRecoverySnapshot?.(),
    getOperationStatus: (request) => current().getOperationStatus(request),
    reprintReceipt: (request) => current().reprintReceipt(request),
  };
}
