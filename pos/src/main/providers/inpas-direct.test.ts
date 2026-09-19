import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  InpasConnectionResult,
  InpasDirectBridge,
  InpasDriverInfo,
  InpasDirectStatus,
  InpasOperationResult,
  InpasSaleRequest,
} from "./inpas-direct-bridge";
import { InpasDirectPaymentProvider } from "./inpas-direct";
import { InpasSettingsStore } from "./inpas-settings";

class FakeBridge implements InpasDirectBridge {
  saleCalls: InpasSaleRequest[] = [];
  reconcileCalls: string[] = [];
  saleResult: InpasOperationResult = {
    success: true,
    outcome: "approved",
    status: "approved",
    operationKind: "sale",
    terminalId: "40000037",
    referenceNumber: "RRN-123",
    terminalTransactionId: "TRX-456",
    authorizationCode: "AUTH-7",
    responseCode: "00",
    transactionStatus: "APPROVED",
    amountMinor: 12345,
    model: "PAX",
    serial: "SERIAL-1",
    receipt: "APPROVED",
  };

  async getDriverInfo(): Promise<InpasDriverInfo> {
    return { installed: true, version: "1.3.18.0", architecture: "x64" };
  }
  async getStatus(): Promise<InpasDirectStatus> {
    return { installed: true, status: "registered" };
  }
  async testConnection(terminalId: string): Promise<InpasConnectionResult> {
    return { success: true, status: "connected", terminalId };
  }
  async sale(request: InpasSaleRequest): Promise<InpasOperationResult> {
    this.saleCalls.push(request);
    return this.saleResult;
  }
  async reconcile(terminalId: string): Promise<InpasOperationResult> {
    this.reconcileCalls.push(terminalId);
    return {
      ...this.saleResult,
      operationKind: "reconcile",
      amountMinor: undefined,
    };
  }
  async stop(): Promise<void> {}
}

describe("InpasDirectPaymentProvider", () => {
  let directory: string;
  let bridge: FakeBridge;
  let provider: InpasDirectPaymentProvider;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "raspechatka-inpas-direct-"));
    const settings = new InpasSettingsStore(join(directory, "settings.json"));
    settings.save({
      version: 2,
      enabled: true,
      adapter: "direct",
      direct: {
        selectedDevice: {
          terminalId: "40000037",
          model: "PAX",
          serial: "SERIAL-1",
        },
      },
    });
    bridge = new FakeBridge();
    provider = new InpasDirectPaymentProvider(settings, bridge);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("maps one unambiguous sale to approved banking evidence", async () => {
    const result = await provider.charge({
      operationId: "attempt-1",
      saleId: "sale-1",
      amountMinor: 12345,
      method: "card",
    });

    expect(bridge.saleCalls).toEqual([{
      terminalId: "40000037",
      amountMinor: 12345,
      currency: "643",
      method: "card",
    }]);
    expect(result).toMatchObject({
      status: "approved",
      transactionId: "TRX-456",
      bankingEvidence: {
        provider: "inpas",
        adapter: "direct",
        terminalId: "40000037",
        referenceNumber: "RRN-123",
        terminalTransactionId: "TRX-456",
        authorizationCode: "AUTH-7",
        responseCode: "00",
        amountMinor: 12345,
        operationKind: "sale",
      },
    });
  });

  it("preserves declined and ambiguous outcomes without approving them", async () => {
    bridge.saleResult = {
      ...bridge.saleResult,
      success: false,
      outcome: "declined",
      status: "declined",
      responseCode: "05",
      terminalTransactionId: undefined,
    };
    expect((await provider.charge({
      operationId: "attempt-2",
      saleId: "sale-2",
      amountMinor: 12345,
      method: "qr",
    })).status).toBe("declined");

    bridge.saleResult = {
      ...bridge.saleResult,
      outcome: "unknown",
      status: "unknown",
      responseCode: undefined,
      transactionStatus: undefined,
    };
    expect((await provider.charge({
      operationId: "attempt-3",
      saleId: "sale-3",
      amountMinor: 12345,
      method: "qr",
    })).status).toBe("unknown");
  });

  it("does not call the bank for direct refund and maps reconcile to operation 59", async () => {
    expect((await provider.refund({
      operationId: "refund-1",
      saleId: "return-1",
      amountMinor: 500,
      method: "card",
    })).status).toBe("declined");
    expect(bridge.saleCalls).toHaveLength(0);

    await provider.reconcile();
    expect(bridge.reconcileCalls).toEqual(["40000037"]);
  });
});
