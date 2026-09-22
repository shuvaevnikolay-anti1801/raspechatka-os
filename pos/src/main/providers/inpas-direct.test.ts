import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  InpasConnectionResult,
  InpasDirectBridge,
  InpasDriverInfo,
  InpasDirectStatus,
  InpasOperationResult,
  InpasRefundRequest,
  InpasSaleRequest,
  InpasVoidRequest,
} from "./inpas-direct-bridge";
import { InpasDirectPaymentProvider } from "./inpas-direct";
import { InpasSettingsStore } from "./inpas";

class FakeBridge implements InpasDirectBridge {
  saleCalls: InpasSaleRequest[] = [];
  refundCalls: InpasRefundRequest[] = [];
  reconcileCalls: string[] = [];
  saleResult: InpasOperationResult = {
    success: true,
    outcome: "approved",
    status: "approved",
    operationKind: "sale",
    terminalId: "30082960",
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
  async refund(request: InpasRefundRequest): Promise<InpasOperationResult> {
    this.refundCalls.push(request);
    return {
      ...this.saleResult,
      operationKind: "refund",
      amountMinor: request.amountMinor,
      referenceNumber: "RRN-REFUND",
      terminalTransactionId: "TRX-REFUND",
    };
  }
  async voidPayment(_request: InpasVoidRequest): Promise<InpasOperationResult> {
    throw new Error("void must not be used as refund");
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

describe("InpasDirectPaymentProvider production operations", () => {
  let directory: string;
  let bridge: FakeBridge;
  let provider: InpasDirectPaymentProvider;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "raspechatka-inpas-direct-"));
    const settingsPath = join(directory, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      enabled: true,
      executablePath: "",
      terminalId: "30082960",
      currencyCode: "643",
      timeoutMs: 3_600_000,
      qrMode: "terminal_choice",
    }));
    bridge = new FakeBridge();
    provider = new InpasDirectPaymentProvider(
      new InpasSettingsStore(settingsPath),
      bridge
    );
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("maps sale operation 1 result into durable banking evidence", async () => {
    const result = await provider.charge({
      operationId: "attempt-1",
      saleId: "sale-1",
      amountMinor: 12345,
      method: "card",
    });

    expect(bridge.saleCalls).toEqual([{
      terminalId: "30082960",
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
        terminalId: "30082960",
        referenceNumber: "RRN-123",
        terminalTransactionId: "TRX-456",
        authorizationCode: "AUTH-7",
        responseCode: "00",
        amountMinor: 12345,
        operationKind: "sale",
      },
    });
  });

  it("runs Refund 29 only from original sale evidence", async () => {
    const result = await provider.refund({
      operationId: "refund-1",
      saleId: "return-1",
      amountMinor: 500,
      method: "card",
      originalPayment: {
        method: "card",
        amountMinor: 12345,
        transactionId: "TRX-456",
        bankingEvidence: {
          provider: "inpas",
          adapter: "direct",
          terminalId: "30082960",
          referenceNumber: "RRN-123",
          terminalTransactionId: "TRX-456",
          authorizationCode: "AUTH-7",
          responseCode: "00",
          amountMinor: 12345,
          operationKind: "sale",
          startedAt: "2026-09-22T10:00:00.000Z",
        },
      },
    });

    expect(result.status).toBe("approved");
    expect(bridge.refundCalls).toEqual([{
      terminalId: "30082960",
      amountMinor: 500,
      currency: "643",
      method: "card",
      referenceNumber: "RRN-123",
      terminalTransactionId: "TRX-456",
      authorizationCode: "AUTH-7",
    }]);
    expect(result.bankingEvidence).toMatchObject({
      operationKind: "refund",
      originalReferenceNumber: "RRN-123",
      originalTerminalTransactionId: "TRX-456",
    });
  });

  it("blocks a bank refund before calling DualConnector when original evidence is absent", async () => {
    const result = await provider.refund({
      operationId: "refund-missing",
      saleId: "return-1",
      amountMinor: 500,
      method: "card",
    });
    expect(result.status).toBe("declined");
    expect(result.message).toMatch(/ReferenceNumber\/RRN/);
    expect(bridge.refundCalls).toHaveLength(0);
  });

  it("runs reconciliation 59 on the selected terminal", async () => {
    const result = await provider.reconcile();
    expect(bridge.reconcileCalls).toEqual(["30082960"]);
    expect(result.message).toMatch(/APPROVED|Сверка/);
  });

  it("does not infer a resolved result after an unknown process outcome", async () => {
    const result = await provider.getOperationStatus({
      operationId: "unknown-1",
      saleId: "sale-1",
      amountMinor: 500,
      method: "card",
    });
    expect(result.status).toBe("unknown");
    expect(bridge.saleCalls).toHaveLength(0);
    expect(bridge.refundCalls).toHaveLength(0);
  });
});
