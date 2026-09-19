import { describe, expect, it, vi } from "vitest";
import { AtolDriverFiscalProvider, type AtolDriverBridge } from "./atol-driver";
import type { AtolSettingsStore } from "./atol-settings";

const settings = {
  version: 2 as const,
  enabled: true,
  adapter: "driver" as const,
  taxationType: "patent",
  taxType: "none",
  direct: {
    selectedDevice: {
      serialNumber: "123",
      modelName: "АТОЛ",
      connection: "usb" as const,
      settingsJson: "{\"port\":\"usb\"}",
    },
  },
  web: { baseUrl: "http://127.0.0.1:16732/api/v2" },
};

describe("AtolDriverFiscalProvider", () => {
  it("sends one JSON fiscal command and uses fiscal document identity", async () => {
    const executeJson = vi.fn(async () => ({
      fiscalParams: {
        fiscalDocumentNumber: "777",
        fiscalSign: "123456",
        shiftNumber: "5",
      },
      documentNumber: "9",
    }));
    const bridge = {
      getDriverInfo: vi.fn(),
      findDevices: vi.fn(),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({ connected: true, serialNumber: "123", shiftState: "opened" })),
      health: vi.fn(),
      executeJson,
    } as unknown as AtolDriverBridge;
    const store = { load: () => settings } as AtolSettingsStore;
    const provider = new AtolDriverFiscalProvider(bridge, store, () => "Анна");

    const result = await provider.fiscalizeSale({
      operationId: "operation-1",
      saleId: "sale-1",
      amountMinor: 10000,
      payments: [{ method: "cash", amountMinor: 10000 }],
      lines: [{ productId: "p", name: "Печать", quantity: 1, unitPriceMinor: 10000, discountPercent: 0 }],
    });

    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(executeJson).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      receiptNumber: "777",
      fiscalDocumentNumber: "777",
      fiscalSign: "123456",
      shiftNumber: "5",
    });
  });

  it("does not accept a non-fiscal receipt counter as proof of fiscalization", async () => {
    const bridge = {
      getDriverInfo: vi.fn(),
      findDevices: vi.fn(),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({ connected: true, serialNumber: "123", shiftState: "opened" })),
      health: vi.fn(),
      executeJson: vi.fn(async () => ({ receiptNumber: "42", documentNumber: "99" })),
    } as unknown as AtolDriverBridge;
    const store = { load: () => settings } as AtolSettingsStore;
    const provider = new AtolDriverFiscalProvider(bridge, store, () => "Анна");

    await expect(provider.fiscalizeSale({
      operationId: "operation-2",
      saleId: "sale-2",
      amountMinor: 10000,
      payments: [{ method: "cash", amountMinor: 10000 }],
      lines: [{ productId: "p", name: "Печать", quantity: 1, unitPriceMinor: 10000, discountPercent: 0 }],
    })).rejects.toThrow("номер фискального документа ФН");
  });
});


describe("AtolDriverFiscalProvider recovery", () => {
  const recover = async (probe: Record<string, unknown>) => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({ connected: true, serialNumber: "123" })),
      recoveryProbe: vi.fn(async () => probe),
    } as unknown as AtolDriverBridge;
    const provider = new AtolDriverFiscalProvider(
      bridge,
      { load: () => settings } as AtolSettingsStore
    );
    return provider.getOperationStatus({
      operationId: "attempt-1",
      entityId: "sale-1",
      kind: "sale",
      expectedAmountMinor: 10000,
      recovery: {
        requestHash: "hash",
        snapshotBefore: {
          kktSerialNumber: "123",
          shiftNumber: "5",
          fiscalDocumentNumber: "10",
          kktDateTime: "2026-09-19T10:00:00.000Z",
        },
      },
    });
  };

  it("recognizes an unambiguous matching new fiscal receipt", async () => {
    await expect(recover({
      kktSerialNumber: "123", shiftNumber: 5, fiscalDocumentNumber: 11,
      fiscalSign: 777, kktDateTime: "2026-09-19T10:00:03.000Z",
      documentClosed: true, receiptKind: "sale", amount: 100,
    })).resolves.toMatchObject({ status: "fiscalized", receiptNumber: "11" });
  });

  it("proves not_found only when the FN document did not progress", async () => {
    await expect(recover({
      kktSerialNumber: "123", shiftNumber: 5, fiscalDocumentNumber: 10,
      kktDateTime: "2026-09-19T10:00:03.000Z", documentClosed: true,
    })).resolves.toMatchObject({ status: "not_found" });
  });

  it("keeps a progressed but mismatched receipt unknown", async () => {
    await expect(recover({
      kktSerialNumber: "123", shiftNumber: 5, fiscalDocumentNumber: 11,
      kktDateTime: "2026-09-19T10:00:03.000Z", documentClosed: true,
      receiptKind: "sale", amount: 99,
    })).resolves.toMatchObject({ status: "unknown" });
  });
});
