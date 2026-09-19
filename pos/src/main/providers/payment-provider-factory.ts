import type { PosDiagnostics } from "../diagnostics";
import type { PaymentProvider, PaymentRequest } from "./contracts";
import { InpasDirectPaymentProvider } from "./inpas-direct";
import type { InpasDirectBridge } from "./inpas-direct-bridge";
import { InpasPaymentProvider } from "./inpas";
import { InpasSettingsStore } from "./inpas-settings";
import { MockPaymentProvider } from "./mock";

export type RoutedPaymentProvider = PaymentProvider & {
  settingsChanged(): void;
};

export function createPaymentProvider(options: {
  trainingMode: boolean;
  settingsStore: InpasSettingsStore;
  legacyProvider: InpasPaymentProvider;
  directBridge: InpasDirectBridge;
  diagnostics?: PosDiagnostics;
}): RoutedPaymentProvider {
  if (options.trainingMode) {
    const mock = new MockPaymentProvider() as RoutedPaymentProvider;
    mock.settingsChanged = () => undefined;
    return mock;
  }

  const direct = new InpasDirectPaymentProvider(
    options.settingsStore,
    options.directBridge,
    options.diagnostics
  );
  const selected = (): PaymentProvider =>
    options.settingsStore.load().adapter === "console"
      ? options.legacyProvider
      : direct;

  return {
    settingsChanged() {
      options.legacyProvider.settingsChanged();
      direct.settingsChanged();
    },
    getAttemptContext() {
      const settings = options.settingsStore.load();
      if (settings.adapter === "direct") return direct.getAttemptContext();
      return {
        provider: "inpas",
        adapter: "console",
        terminalId: settings.console.terminalId || undefined,
      };
    },
    healthCheck: () => selected().healthCheck(),
    charge: (request: PaymentRequest) => selected().charge(request),
    refund: (request: PaymentRequest) => selected().refund(request),
    getOperationStatus: (request: PaymentRequest) =>
      selected().getOperationStatus(request),
    testConnection: () => selected().testConnection(),
    reconcile: () => selected().reconcile(),
  };
}
