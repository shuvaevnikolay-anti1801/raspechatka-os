import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const TEST_CONNECTION_TIMEOUT_MS = 120_000;
const BANK_OPERATION_TIMEOUT_MS = 3_600_000;
const RECONCILE_TIMEOUT_MS = 300_000;

export type InpasDriverInfo = {
  installed: boolean;
  version?: string;
  architecture?: "x64";
  code?: string;
  error?: string;
};

export type InpasDirectStatus = {
  installed: boolean;
  status: string;
  version?: string;
};

export type InpasOperationOutcome = "approved" | "declined" | "unknown";

export type InpasConnectionResult = {
  success: boolean;
  outcome?: InpasOperationOutcome;
  status: string;
  operationKind?: "test";
  terminalId: string;
  referenceNumber?: string;
  terminalTransactionId?: string;
  authorizationCode?: string;
  model?: string;
  serial?: string;
  responseCode?: string;
  responseDescription?: string;
  transactionStatus?: string;
  receipt?: string;
};

export type InpasOperationResult = {
  success: boolean;
  outcome: InpasOperationOutcome;
  status: string;
  operationKind: "sale" | "reconcile";
  terminalId: string;
  referenceNumber?: string;
  terminalTransactionId?: string;
  authorizationCode?: string;
  model?: string;
  serial?: string;
  responseCode?: string;
  responseDescription?: string;
  transactionStatus?: string;
  amountMinor?: number;
  receipt?: string;
};

export type InpasSaleRequest = {
  terminalId: string;
  amountMinor: number;
  currency: "643";
  method: "card" | "qr";
};

export interface InpasDirectBridge {
  getDriverInfo(): Promise<InpasDriverInfo>;
  getStatus(): Promise<InpasDirectStatus>;
  testConnection(terminalId: string): Promise<InpasConnectionResult>;
  sale(request: InpasSaleRequest): Promise<InpasOperationResult>;
  reconcile(terminalId: string): Promise<InpasOperationResult>;
  stop(): Promise<void>;
}

type BridgeCommand =
  | "driverInfo"
  | "status"
  | "testConnection"
  | "sale"
  | "reconcile"
  | "shutdown";
type BridgeResponse<T> = {
  protocolVersion: number;
  id: string;
  ok: boolean;
  result?: T;
  error?: { code?: string; message: string; nativeErrorCode?: number };
};

export type NativeInpasBridgeOptions = {
  executablePath: string;
  timeoutMs?: number;
  testConnectionTimeoutMs?: number;
  bankOperationTimeoutMs?: number;
  reconcileTimeoutMs?: number;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio
  ) => ChildProcessWithoutNullStreams;
};

export class InpasBridgeError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly nativeErrorCode?: number
  ) {
    super(message);
    this.name = "InpasBridgeError";
  }
}

export class NativeInpasBridge implements InpasDirectBridge {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private stopped = false;

  constructor(private readonly options: NativeInpasBridgeOptions) {}

  getDriverInfo(): Promise<InpasDriverInfo> {
    return this.request("driverInfo");
  }

  getStatus(): Promise<InpasDirectStatus> {
    return this.request("status");
  }

  testConnection(terminalId: string): Promise<InpasConnectionResult> {
    this.assertTerminalId(terminalId);
    return this.request("testConnection", { terminalId });
  }

  sale(request: InpasSaleRequest): Promise<InpasOperationResult> {
    this.assertTerminalId(request.terminalId);
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0)
      return Promise.reject(new InpasBridgeError(
        "Сумма INPAS должна быть положительным целым числом копеек", "invalid_amount"
      ));
    if (request.currency !== "643")
      return Promise.reject(new InpasBridgeError(
        "Direct INPAS поддерживает валюту 643", "invalid_currency"
      ));
    if (request.method !== "card" && request.method !== "qr")
      return Promise.reject(new InpasBridgeError(
        "Direct INPAS поддерживает оплату картой или QR", "invalid_method"
      ));
    return this.request("sale", request);
  }

  reconcile(terminalId: string): Promise<InpasOperationResult> {
    this.assertTerminalId(terminalId);
    return this.request("reconcile", { terminalId });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopped = true;
    if (!child) return;
    try {
      await this.request("shutdown");
    } catch {
      // The helper may already have exited. Cleanup below remains authoritative.
    }
    if (child.exitCode !== null || child.killed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill(), 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private assertTerminalId(terminalId: string): void {
    if (!/^\d{1,32}$/.test(terminalId))
      throw new InpasBridgeError(
        "Для операции требуется числовой Terminal ID", "invalid_terminal_id"
      );
  }

  private request<T>(
    command: BridgeCommand,
    args?: Record<string, unknown>
  ): Promise<T> {
    const child = this.ensureStarted();
    const id = String(this.nextId++);
    const timeoutMs =
      command === "sale"
        ? this.options.bankOperationTimeoutMs ?? BANK_OPERATION_TIMEOUT_MS
        : command === "reconcile"
          ? this.options.reconcileTimeoutMs ?? RECONCILE_TIMEOUT_MS
          : command === "testConnection"
            ? this.options.testConnectionTimeoutMs ?? TEST_CONNECTION_TIMEOUT_MS
            : this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new InpasBridgeError(
          `INPAS bridge timed out while running ${command}`, "timeout"
        );
        reject(error);
        this.resetChild(child, error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        id,
        command,
        args,
      }) + "\n", (error) => {
        if (error) this.rejectPending(id, error);
      });
    });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.stopped) throw new InpasBridgeError("INPAS bridge has been stopped", "stopped");
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(this.options.executablePath, [], {
      shell: false,
      windowsHide: true,
    });
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      console.error(`[inpas-bridge] ${line}`);
    });
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failAll(error);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failAll(new InpasBridgeError(
        `INPAS bridge exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
        "bridge_exited"
      ));
    });
    return child;
  }

  private handleLine(line: string): void {
    let response: BridgeResponse<unknown>;
    try {
      response = JSON.parse(line) as BridgeResponse<unknown>;
    } catch {
      console.error("[inpas-bridge] invalid protocol JSON");
      return;
    }
    if (response.protocolVersion !== PROTOCOL_VERSION || !response.id) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }
    pending.reject(new InpasBridgeError(
      response.error?.message ?? "INPAS bridge request failed",
      response.error?.code,
      response.error?.nativeErrorCode
    ));
  }

  private resetChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.failAll(error);
    try { child.kill(); } catch {}
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
  }
}
