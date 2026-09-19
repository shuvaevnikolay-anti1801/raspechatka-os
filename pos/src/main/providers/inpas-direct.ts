import type {
  BankingEvidence,
  PaymentServiceResult,
} from "../../shared/contracts";
import type {
  DeviceHealth,
  PaymentAttemptContext,
  PaymentProvider,
  PaymentRecoveryEvidence,
  PaymentRequest,
  PaymentResult,
} from "./contracts";
import type {
  InpasDirectBridge,
  InpasOperationResult,
} from "./inpas-direct-bridge";
import { InpasSettingsStore } from "./inpas-settings";

export class InpasDirectPaymentProvider implements PaymentProvider {
  constructor(
    private readonly settingsStore: InpasSettingsStore,
    private readonly bridge: InpasDirectBridge
  ) {}

  settingsChanged(): void {}

  getAttemptContext(): PaymentAttemptContext {
    const selected = this.selectedDevice();
    return {
      provider: "inpas",
      adapter: "direct",
      terminalId: selected.terminalId,
    };
  }

  async healthCheck(): Promise<DeviceHealth> {
    const settings = this.settingsStore.load();
    if (!settings.enabled || settings.adapter !== "direct")
      return {
        ready: false,
        status: "not_configured",
        message: "Прямое подключение INPAS не выбрано",
      };
    const selected = settings.direct?.selectedDevice;
    if (!selected)
      return {
        ready: false,
        status: "not_configured",
        message: "Терминал INPAS не выбран",
      };
    try {
      const driver = await this.bridge.getDriverInfo();
      if (!driver.installed)
        return {
          ready: false,
          status: "not_configured",
          message: driver.error || "INPAS DualConnector не зарегистрирован",
          details: { code: driver.code, version: driver.version },
        };
      const result = await this.bridge.testConnection(selected.terminalId);
      const identityMatches = result.terminalId === selected.terminalId;
      return {
        ready: result.success && identityMatches,
        status: result.success && identityMatches ? "ready" : "offline",
        message: identityMatches
          ? result.responseDescription || (result.success ? "INPAS / PAX готов" : "Терминал не ответил")
          : "Ответил другой Terminal ID. Операция заблокирована",
        details: {
          terminalId: selected.terminalId,
          model: result.model,
          serial: result.serial,
          responseCode: result.responseCode,
        },
      };
    } catch (error) {
      return {
        ready: false,
        status: "offline",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async charge(request: PaymentRequest): Promise<PaymentResult> {
    if (request.method !== "card" && request.method !== "qr")
      return {
        status: "declined",
        message: "Direct INPAS поддерживает только оплату картой или QR",
      };
    const selected = this.selectedDevice();
    const startedAt = new Date().toISOString();
    const result = await this.bridge.sale({
      terminalId: selected.terminalId,
      amountMinor: request.amountMinor,
      currency: "643",
      method: request.method,
    });
    const evidence = this.evidence(result, "sale", request.amountMinor, startedAt);
    if (result.terminalId !== selected.terminalId)
      return {
        status: "unknown",
        bankingEvidence: evidence,
        message: "Банк ответил для другого Terminal ID. Результат операции требует ручной проверки",
        raw: result,
      };
    if (result.outcome === "declined")
      return {
        status: "declined",
        bankingEvidence: evidence,
        message: result.responseDescription || "Банк отклонил оплату",
        raw: result,
      };
    if (result.outcome !== "approved")
      return {
        status: "unknown",
        bankingEvidence: evidence,
        message: result.responseDescription || "Банк не вернул однозначный результат оплаты",
        raw: result,
      };

    const transactionId = result.terminalTransactionId || result.referenceNumber;
    return {
      status: "approved",
      transactionId,
      bankingEvidence: evidence,
      message: result.responseDescription || "Оплата подтверждена",
      raw: result,
    };
  }

  async refund(request: PaymentRequest): Promise<PaymentResult> {
    if (request.method !== "card" && request.method !== "qr")
      return {
        status: "declined",
        message: "Direct INPAS Refund поддерживает только card/qr",
      };
    const original = request.originalPayment?.bankingEvidence;
    if (
      !original ||
      original.provider !== "inpas" ||
      original.operationKind !== "sale" ||
      !original.terminalId ||
      !original.referenceNumber
    )
      return {
        status: "declined",
        message:
          "Возврат INPAS не начат: у исходной продажи нет Terminal ID и ReferenceNumber/RRN",
      };
    if (request.amountMinor > request.originalPayment!.amountMinor)
      return {
        status: "declined",
        message: "Сумма возврата превышает исходный банковский платёж",
      };

    const selected = this.selectedDevice();
    if (selected.terminalId !== original.terminalId)
      return {
        status: "declined",
        message: "Возврат INPAS разрешён только на исходном Terminal ID",
      };

    const startedAt = new Date().toISOString();
    const result = await this.bridge.refund({
      terminalId: original.terminalId,
      amountMinor: request.amountMinor,
      currency: "643",
      method: request.method,
      referenceNumber: original.referenceNumber,
      terminalTransactionId: original.terminalTransactionId,
      authorizationCode: original.authorizationCode,
    });
    const evidence = this.evidence(
      result,
      "refund",
      request.amountMinor,
      startedAt,
      original
    );
    if (result.terminalId !== original.terminalId)
      return {
        status: "unknown",
        bankingEvidence: evidence,
        message: "Refund ответил для другого Terminal ID. Требуется ручная проверка",
        raw: result,
      };
    if (result.outcome === "declined")
      return {
        status: "declined",
        bankingEvidence: evidence,
        message: result.responseDescription || "Банк отклонил возврат",
        raw: result,
      };
    if (result.outcome !== "approved")
      return {
        status: "unknown",
        bankingEvidence: evidence,
        message: result.responseDescription || "Банк не вернул однозначный итог Refund 29",
        raw: result,
      };
    return {
      status: "approved",
      transactionId: result.terminalTransactionId || result.referenceNumber,
      bankingEvidence: evidence,
      message: result.responseDescription || "Банковский возврат подтверждён",
      raw: result,
    };
  }

  async getOperationStatus(request: PaymentRequest): Promise<PaymentResult> {
    const proven = this.provenStoredResult(request, request.recovery);
    if (proven) return proven;
    return {
      status: "unknown",
      message:
        "Точный результат INPAS не доказан. Проверьте операцию в терминале или банковском журнале; повторять её автоматически нельзя.",
    };
  }

  async testConnection(): Promise<PaymentServiceResult> {
    const selected = this.selectedDevice();
    const result = await this.bridge.testConnection(selected.terminalId);
    if (!result.success || result.terminalId !== selected.terminalId)
      throw new Error(
        result.terminalId !== selected.terminalId
          ? "Ответил другой Terminal ID"
          : result.responseDescription || "Терминал INPAS не ответил"
      );
    return {
      message: result.responseDescription || "Связь с INPAS / PAX установлена",
      receipt: result.receipt,
      raw: result,
    };
  }

  async reconcile(): Promise<PaymentServiceResult> {
    const selected = this.selectedDevice();
    const result = await this.bridge.reconcile(selected.terminalId);
    if (result.terminalId !== selected.terminalId)
      throw new Error("Сверка итогов вернула другой Terminal ID");
    if (result.outcome !== "approved")
      throw new Error(result.responseDescription || "Сверка итогов INPAS не подтверждена");
    return {
      message: result.responseDescription || "Сверка итогов INPAS выполнена",
      receipt: result.receipt,
      raw: result,
    };
  }

  private provenStoredResult(
    request: PaymentRequest,
    recovery: PaymentRecoveryEvidence | undefined
  ): PaymentResult | undefined {
    const stored = recovery?.safeResult;
    if (
      !stored ||
      (stored.status !== "approved" && stored.status !== "declined") ||
      recovery.state !== stored.status ||
      recovery.provider !== "inpas" ||
      recovery.adapter !== "direct" ||
      recovery.kind !== (request.recovery?.kind ?? recovery.kind) ||
      recovery.kind !== (request.originalPayment ? "refund" : recovery.kind) ||
      recovery.method !== request.method ||
      recovery.amountMinor !== request.amountMinor ||
      !recovery.requestHash ||
      !/^[a-f0-9]{64}$/i.test(recovery.requestHash)
    )
      return undefined;

    const expectedKind = recovery.kind;
    if (expectedKind !== "sale" && expectedKind !== "refund") return undefined;
    const evidence = stored.bankingEvidence;
    const settings = this.settingsStore.load();
    const selected = settings.adapter === "direct"
      ? settings.direct?.selectedDevice
      : undefined;
    if (
      !selected ||
      !evidence ||
      evidence.provider !== "inpas" ||
      evidence.adapter !== "direct" ||
      evidence.operationKind !== expectedKind ||
      evidence.terminalId !== recovery.terminalId ||
      evidence.terminalId !== selected.terminalId ||
      evidence.amountMinor !== request.amountMinor
    )
      return undefined;

    if (
      (recovery.referenceNumber && evidence.referenceNumber !== recovery.referenceNumber) ||
      (recovery.terminalTransactionId &&
        evidence.terminalTransactionId !== recovery.terminalTransactionId) ||
      (recovery.authorizationCode &&
        evidence.authorizationCode !== recovery.authorizationCode) ||
      (recovery.responseCode && evidence.responseCode !== recovery.responseCode)
    )
      return undefined;

    const attemptStartedAt = Date.parse(recovery.startedAt || "");
    const resultStartedAt = Date.parse(evidence.startedAt || "");
    const resultCompletedAt = Date.parse(evidence.completedAt || "");
    if (
      !Number.isFinite(attemptStartedAt) ||
      !Number.isFinite(resultStartedAt) ||
      !Number.isFinite(resultCompletedAt) ||
      resultStartedAt < attemptStartedAt - 5_000 ||
      resultCompletedAt < resultStartedAt
    )
      return undefined;

    if (stored.status === "approved") {
      const bankId = evidence.terminalTransactionId || evidence.referenceNumber;
      if (!bankId || stored.transactionId !== bankId) return undefined;
    } else if (!evidence.responseCode && !evidence.transactionStatus) {
      return undefined;
    }

    return {
      status: stored.status,
      transactionId: stored.transactionId,
      bankingEvidence: evidence,
      message: stored.message,
      raw: stored.raw,
    };
  }

  private selectedDevice(): { terminalId: string; model?: string; serial?: string } {
    const settings = this.settingsStore.load();
    const selected = settings.direct?.selectedDevice;
    if (!settings.enabled || settings.adapter !== "direct" || !selected)
      throw new Error("Прямой терминал INPAS не выбран или отключён");
    return selected;
  }

  private evidence(
    result: InpasOperationResult,
    operationKind: "sale" | "refund",
    amountMinor: number,
    startedAt: string,
    original?: BankingEvidence
  ): BankingEvidence {
    return {
      provider: "inpas",
      adapter: "direct",
      terminalId: result.terminalId,
      referenceNumber: result.referenceNumber,
      terminalTransactionId: result.terminalTransactionId,
      authorizationCode: result.authorizationCode,
      responseCode: result.responseCode,
      transactionStatus: result.transactionStatus,
      amountMinor,
      operationKind,
      originalReferenceNumber: original?.referenceNumber,
      originalTerminalTransactionId: original?.terminalTransactionId,
      startedAt,
      completedAt: new Date().toISOString(),
      model: result.model,
      serial: result.serial,
      receipt: result.receipt,
    };
  }
}
