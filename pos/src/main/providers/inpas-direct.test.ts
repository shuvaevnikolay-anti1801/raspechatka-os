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
  InpasRefundRequest,
  InpasSaleRequest,
  InpasVoidRequest,
} from "./inpas-direct-bridge";
import { InpasDirectPaymentProvider } from "./inpas-direct";
import { InpasSettingsStore } from "./inpas-settings";

class FakeBridge implements InpasDirectBridge {
  saleCalls: InpasSaleRequest[] = [];
  refundCalls: InpasRefundRequest[] = [];
  voidCalls: InpasVoidRequest[] = [];
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
  async refund(request: InpasRefundRequest): Promise<InpasOperationResult> {
    this.refundCalls.push(request);
    return { ...this.saleResult, operationKind: "refund", amountMinor: request.amountMinor };
  }
  async voidPayment(request: InpasVoidRequest): Promise<InpasOperationResult> {
    this.voidCalls.push(request);
    return { ...this.saleResult, operationKind: "void", amountMinor: request.amountMinor };
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

  it("runs Refund 29 only with original sale evidence", async () => {
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
          terminalId: "40000037",
          referenceNumber: "RRN-123",
          terminalTransactionId: "TRX-456",
          authorizationCode: "AUTH-7",
          responseCode: "00",
          amountMinor: 12345,
          operationKind: "sale",
          startedAt: "2026-09-19T10:00:00.000Z",
        },
      },
    });

    expect(result.status).toBe("approved");
    expect(bridge.refundCalls).toEqual([{
      terminalId: "40000037",
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
    expect(bridge.voidCalls).toHaveLength(0);
  });

  it("blocks refund without evidence before calling the bridge", async () => {
    const result = await provider.refund({
      operationId: "refund-missing",
      saleId: "return-1",
      amountMinor: 500,
      method: "card",
    });
    expect(result.status).toBe("declined");
    expect(result.message).toMatch(/ReferenceNumber\/RRN/);
    expect(bridge.refundCalls).toHaveLength(0);
    expect(bridge.voidCalls).toHaveLength(0);
  });

  it("maps reconciliation independently from refund and void", async () => {
    await provider.reconcile();
    expect(bridge.reconcileCalls).toEqual(["40000037"]);
    expect(bridge.refundCalls).toHaveLength(0);
    expect(bridge.voidCalls).toHaveLength(0);
  });
  it("recovers only an exact stored approved result without calling DualConnector", async () => {
    const evidence = {
      provider: "inpas" as const,
      adapter: "direct" as const,
      terminalId: "40000037",
      referenceNumber: "RRN-RECOVERED",
      terminalTransactionId: "TRX-RECOVERED",
      authorizationCode: "AUTH-RECOVERED",
      responseCode: "00",
      transactionStatus: "APPROVED",
      amountMinor: 500,
      operationKind: "sale" as const,
      startedAt: "2026-09-19T10:00:00.000Z",
      completedAt: "2026-09-19T10:00:05.000Z",
    };
    const result = await provider.getOperationStatus({
      operationId: "attempt-recovered",
      saleId: "sale-recovered",
      amountMinor: 500,
      method: "card",
      recovery: {
        state: "approved",
        kind: "sale",
        method: "card",
        amountMinor: 500,
        transactionId: "TRX-RECOVERED",
        provider: "inpas",
        adapter: "direct",
        terminalId: "40000037",
        referenceNumber: "RRN-RECOVERED",
        terminalTransactionId: "TRX-RECOVERED",
        authorizationCode: "AUTH-RECOVERED",
        responseCode: "00",
        requestHash: "a".repeat(64),
        startedAt: "2026-09-19T10:00:00.000Z",
        safeResult: {
          status: "approved",
          transactionId: "TRX-RECOVERED",
          bankingEvidence: evidence,
          message: "APPROVED",
        },
      },
    });

    expect(result).toMatchObject({
      status: "approved",
      transactionId: "TRX-RECOVERED",
      bankingEvidence: { referenceNumber: "RRN-RECOVERED" },
    });
    expect(bridge.saleCalls).toHaveLength(0);
    expect(bridge.refundCalls).toHaveLength(0);
  });

  it("returns stored declined proof but keeps mismatched evidence unknown", async () => {
    const evidence = {
      provider: "inpas" as const,
      adapter: "direct" as const,
      terminalId: "40000037",
      responseCode: "05",
      transactionStatus: "DECLINED",
      amountMinor: 500,
      operationKind: "refund" as const,
      startedAt: "2026-09-19T11:00:00.000Z",
      completedAt: "2026-09-19T11:00:04.000Z",
    };
    const recovery = {
      state: "declined" as const,
      kind: "refund" as const,
      method: "card" as const,
      amountMinor: 500,
      provider: "inpas",
      adapter: "direct",
      terminalId: "40000037",
      responseCode: "05",
      requestHash: "b".repeat(64),
      startedAt: "2026-09-19T11:00:00.000Z",
      safeResult: {
        status: "declined" as const,
        bankingEvidence: evidence,
        message: "DECLINED",
      },
    };

    expect((await provider.getOperationStatus({
      operationId: "refund-declined",
      saleId: "return-declined",
      amountMinor: 500,
      method: "card",
      recovery,
    })).status).toBe("declined");

    const ambiguous = await provider.getOperationStatus({
      operationId: "refund-ambiguous",
      saleId: "return-ambiguous",
      amountMinor: 600,
      method: "card",
      recovery,
    });
    expect(ambiguous.status).toBe("unknown");
    expect(ambiguous.message).toMatch(/банковском журнале/);
    expect(bridge.saleCalls).toHaveLength(0);
    expect(bridge.refundCalls).toHaveLength(0);
  });

});
