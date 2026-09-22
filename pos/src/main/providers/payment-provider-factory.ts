import type { PosDiagnostics } from "../diagnostics";
import type { PaymentProvider, PaymentRequest } from "./contracts";
import { InpasDirectPaymentProvider } from "./inpas-direct";
import type { InpasDirectBridge } from "./inpas-direct-bridge";
import { InpasPaymentProvider, InpasSettingsStore } from "./inpas";
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
  // Production defaults to the evidence-capable direct COM path.
  // The old DC Console adapter remains available only as an explicit hidden fallback.
  const adapter = process.env.RASPECHATKA_INPAS_ADAPTER === "console"
    ? "console"
    : "direct";
  const selected = (): PaymentProvider =>
    adapter === "console" ? options.legacyProvider : direct;

  return {
    settingsChanged() {
      options.legacyProvider.settingsChanged();
      direct.settingsChanged();
    },
    getAttemptContext() {
      const settings = options.settingsStore.load();
      return {
        provider: "inpas",
        adapter,
        terminalId: settings.terminalId || undefined,
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
