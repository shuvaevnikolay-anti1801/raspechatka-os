import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DeviceHealth } from './contracts';
import type {
  AtolDriverBridge,
  AtolDriverDevice,
  AtolDriverInfo,
  AtolDriverDiagnostics,
  AtolBridgeClientDiagnostics,
  AtolRecoveryProbe,
  AtolDriverStatus,
} from './atol-driver';

const PROTOCOL_VERSION = 1;
// Native driver calls time out first (8s / 55s). These are transport
// watchdogs that give the helper time to return its stage-aware error.
const READ_ONLY_TIMEOUT_MS = 12_000;
const FISCAL_OPERATION_TIMEOUT_MS = 60_000;
const TRANSPORT_HISTORY_LIMIT = 200;
export const ATOL_BRIDGE_EXECUTABLE = 'Raspechatka.AtolBridge.exe';

export function resolveAtolBridgeLogPath(): string | undefined {
  const appData = process.env.APPDATA;
  return appData
    ? join(appData, 'Kassa-Raspechatka', 'logs', 'atol-bridge.log')
    : undefined;
}

export class AtolBridgeError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly driverErrorCode?: number,
    readonly driverErrorDescription?: string,
    readonly stage?: string
  ) {
    super(message);
    this.name = 'AtolBridgeError';
  }
}

export class AtolBridgeNotConfiguredError extends AtolBridgeError {
  constructor(executablePath: string) {
    super(`ATOL bridge helper is not installed: ${executablePath}`, 'not_configured');
    this.name = 'AtolBridgeNotConfiguredError';
  }
}

export function resolveAtolBridgeExecutablePath(options: { isPackaged?: boolean } = {}): string {
  const electronProcess = process as NodeJS.Process & {
    resourcesPath?: string; defaultApp?: boolean;
  };
  const isPackaged = options.isPackaged ??
    Boolean(electronProcess.resourcesPath && !electronProcess.defaultApp);
  if (isPackaged) {
    return join(electronProcess.resourcesPath ?? '', 'native', 'atol', ATOL_BRIDGE_EXECUTABLE);
  }
  return process.env.RASPECHATKA_ATOL_BRIDGE_PATH ??
    join(process.cwd(), 'native', 'atol-bridge', 'publish', ATOL_BRIDGE_EXECUTABLE);
}

export function isAtolBridgeExecutableAvailable(executablePath: string): boolean {
  return existsSync(executablePath);
}

type BridgeCommand =
  | 'driverInfo'
  | 'diagnostics'
  | 'discover'
  | 'connect'
  | 'disconnect'
  | 'status'
  | 'recoveryProbe'
  | 'executeJson'
  | 'reprintDocument'
  | 'shutdown';

type BridgeRequest = {
  protocolVersion: number;
  id: string;
  command: BridgeCommand;
  args?: Record<string, unknown>;
};

type BridgeResponse<T> = {
  protocolVersion: number;
  id: string;
  ok: boolean;
  result?: T;
  error?: {
    code?: string;
    message: string;
    driverErrorCode?: number;
    driverErrorDescription?: string;
    stage?: string;
  };
};

export type NativeAtolDriverBridgeOptions = {
  executablePath: string;
  args?: string[];
  readOnlyTimeoutMs?: number;
  fiscalOperationTimeoutMs?: number;
};

/** FN readiness requires positive evidence; OFD delivery is a separate channel. */
export function healthFromAtolStatus(status: AtolDriverStatus): DeviceHealth {
  const ready = Boolean(
    status.connected &&
    status.shiftState !== 'expired' &&
    status.paperPresent !== false &&
    !status.coverOpened &&
    !status.printerConnectionLost &&
    !status.printerError &&
    status.fnPresent === true &&
    !status.invalidFn &&
    !status.deviceBlocked
  );
  return {
    ready,
    status: ready ? 'ready' : 'error',
    message: ready ? 'АТОЛ подключён'
      : status.fnPresent !== true ? 'Готовность ФН не подтверждена'
        : status.errorDescription ?? 'АТОЛ требует внимания',
  };
}

export class NativeAtolDriverBridge implements AtolDriverBridge {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeout?: NodeJS.Timeout;
      command: BridgeCommand;
      startedAt: number;
    }
  >();
  private nextId = 1;
  private stopped = false;
  private readonly stdoutHistory: string[] = [];
  private readonly stderrHistory: string[] = [];
  private lastRequest: AtolBridgeClientDiagnostics['lastRequest'] = {
    command: '',
    id: '',
    timestamp: '',
  };
  private lastResponse: AtolBridgeClientDiagnostics['lastResponse'] = {
    received: false,
    raw: '',
    parsed: false,
  };
  private lastDurationMs = 0;
  private lastError?: string;
  private diagnosticsFileUnavailable = false;

  constructor(private readonly options: NativeAtolDriverBridgeOptions) {}

  async getDriverInfo(): Promise<AtolDriverInfo> {
    return this.request<AtolDriverInfo>('driverInfo');
  }

  async diagnostics(): Promise<AtolDriverDiagnostics> {
    const result = await this.request<AtolDriverDiagnostics>('diagnostics');
    const timedOut = result.steps.some((step) => step.error === 'timeout');
    if (timedOut && this.child) {
      this.resetTimedOutChild(
        this.child,
        new AtolBridgeError(
          'ATOL Driver diagnostic call exceeded timeout',
          'driver_timeout',
          undefined,
          undefined,
          result.stage
        )
      );
    }
    return result;
  }

  getDiagnostics(): AtolBridgeClientDiagnostics {
    const child = this.child;
    const running = Boolean(child && child.exitCode === null && !child.killed);
    return {
      bridgePath: this.options.executablePath,
      process: {
        running,
        ...(running && child?.pid ? { pid: child.pid } : {}),
      },
      lastRequest: { ...this.lastRequest },
      lastResponse: { ...this.lastResponse },
      transport: {
        stdout: [...this.stdoutHistory],
        stderr: [...this.stderrHistory],
      },
      timing: { durationMs: this.lastDurationMs },
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async getStatus(): Promise<AtolDriverStatus> {
    return this.request<AtolDriverStatus>('status');
  }

  async recoveryProbe(): Promise<AtolRecoveryProbe> {
    return this.request<AtolRecoveryProbe>('recoveryProbe');
  }

  async executeJson(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('executeJson', {
      json: JSON.stringify(request),
    });
  }

  async reprintDocument(documentNumber: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('reprintDocument', { documentNumber });
  }

  async findDevices(): Promise<AtolDriverDevice[]> {
    const devices = await this.request<AtolDriverDevice[]>('discover');
    return devices.map((device) => ({
      ...device,
      id: device.id || `atol:${device.serialNumber}`,
      modelName: device.modelName ?? '',
      connection: device.connection ?? 'unknown',
    }));
  }

  async connect(device: AtolDriverDevice): Promise<void> {
    await this.request('connect', {
      settingsJson: device.settingsJson,
      expectedSerialNumber: device.serialNumber,
    });
  }

  async disconnect(): Promise<void> {
    if (this.child) {
      await this.request('disconnect');
    }
  }

  async health(): Promise<DeviceHealth> {
    try {
      const status = await this.request<AtolDriverStatus>('status');
      return healthFromAtolStatus(status);
    } catch (error) {
      return {
        ready: false,
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Не удалось проверить АТОЛ',
      } as DeviceHealth;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.stopped = true;
      return;
    }

    try {
      await this.request('shutdown');
    } catch {
      // The helper may already be terminating; process cleanup below is authoritative.
    }

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.killed) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        child.kill();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.stopped = true;
  }

  private async request<T = void>(
    command: BridgeCommand,
    args?: Record<string, unknown>
  ): Promise<T> {
    const child = this.ensureStarted();
    const id = String(this.nextId++);
    const request: BridgeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      id,
      command,
      args,
    };
    const startedAt = Date.now();
    this.lastRequest = {
      command,
      id,
      timestamp: new Date(startedAt).toISOString(),
    };
    this.lastResponse = { received: false, raw: '', parsed: false };
    this.lastDurationMs = 0;
    this.lastError = undefined;

    return new Promise<T>((resolve, reject) => {
      const entry: {
        resolve: (value: unknown) => void;
        reject: (reason: Error) => void;
        timeout?: NodeJS.Timeout;
        command: BridgeCommand;
        startedAt: number;
      } = {
        resolve: (value) => resolve(value as T),
        reject,
        command,
        startedAt,
      };

      const timeoutMs =
        command === 'executeJson' || command === 'reprintDocument'
          ? this.options.fiscalOperationTimeoutMs ?? FISCAL_OPERATION_TIMEOUT_MS
          : command !== 'shutdown'
            ? this.options.readOnlyTimeoutMs ?? READ_ONLY_TIMEOUT_MS
            : undefined;
      if (timeoutMs !== undefined) {
        entry.timeout = setTimeout(() => {
          const durationMs = Date.now() - startedAt;
          const lastStdout = this.lastResponse.raw || '(none)';
          const lastStderr = this.stderrHistory.slice(-20).join('\n') || '(none)';
          const error = new AtolBridgeError(
            [
              'ATOL bridge timeout',
              '',
              'command:',
              command,
              '',
              'requestId:',
              id,
              '',
              'duration:',
              `${durationMs}ms`,
              '',
              'last stdout:',
              lastStdout,
              '',
              'last stderr:',
              lastStderr,
              '',
              'operation result is unknown',
            ].join('\n'),
            'bridge_timeout',
            undefined,
            undefined,
            command
          );
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            this.finishPending(id, pending, 'timeout', error);
          }
          reject(error);
          this.resetTimedOutChild(child, error);
        }, timeoutMs);
      }

      this.pending.set(id, entry);
      this.logDiagnostics('request sent', {
        ...this.requestForDiagnostics(request),
        startedAt: this.lastRequest.timestamp,
      });
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) {
          return;
        }
        this.rejectPending(id, error);
      });
    });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    if (this.stopped) {
      throw new Error('ATOL bridge has been stopped');
    }

    this.logDiagnostics('executable path', this.options.executablePath);
    if (!isAtolBridgeExecutableAvailable(this.options.executablePath)) {
      const error = new AtolBridgeNotConfiguredError(this.options.executablePath);
      this.lastError = error.message;
      this.logDiagnostics('executable not found', this.options.executablePath);
      throw error;
    }

    const child = spawn(this.options.executablePath, this.options.args ?? [], {
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    this.logDiagnostics('process spawned', { pid: child.pid });

    createInterface({ input: child.stdout }).on('line', (line) => {
      this.pushTransport(this.stdoutHistory, line);
      this.lastResponse = { received: true, raw: line, parsed: false };
      this.logDiagnostics('stdout received', line);
      this.handleResponse(line);
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.pushTransport(this.stderrHistory, line);
      this.logBridgeStderr(line);
    });
    child.on('error', (error) => {
      this.lastError = error.message;
      this.logDiagnostics('process error', error.message);
      if (this.child !== child) return;
      this.child = undefined;
      this.failAll(error);
    });
    child.on('exit', (code, signal) => {
      this.logDiagnostics('bridge exit', { code, signal });
      if (this.child !== child) return;
      this.child = undefined;
      this.failAll(
        new Error(
          `ATOL bridge exited${code === null ? '' : ` with code ${code}`}${
            signal ? ` (${signal})` : ''
          }`
        )
      );
    });
    child.on('close', (code, signal) => {
      this.logDiagnostics('bridge close', { code, signal });
    });

    return child;
  }

  private handleResponse(line: string): void {
    let response: BridgeResponse<unknown>;
    try {
      response = JSON.parse(line) as BridgeResponse<unknown>;
      this.lastResponse = { received: true, raw: line, parsed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `invalid JSON response: ${message}`;
      this.logDiagnostics('invalid JSON response', { raw: line, error: message });
      return;
    }

    if (response.protocolVersion !== PROTOCOL_VERSION || !response.id) {
      this.lastError = 'invalid protocol response';
      this.logDiagnostics('invalid protocol response', response);
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    if (response.ok) {
      this.finishPending(response.id, pending, 'ok');
      pending.resolve(response.result);
      return;
    }

    const detail = response.error?.driverErrorDescription;
    const code = response.error?.code;
    const stage = response.error?.stage;
    const error = new AtolBridgeError(
      this.describeFailure(
        code,
        stage,
        response.error?.message ?? 'ATOL bridge request failed',
        detail
      ),
      code,
      response.error?.driverErrorCode,
      detail,
      stage
    );
    this.finishPending(response.id, pending, 'error', error);
    pending.reject(error);

    if (code === 'driver_timeout' && this.child) {
      // The native helper intentionally terminates after a timed-out COM call.
      // Detach/kill it immediately so a fast retry cannot reuse the blocked STA.
      this.resetTimedOutChild(this.child, error);
    }
  }

  private describeFailure(
    code: string | undefined,
    stage: string | undefined,
    message: string,
    detail?: string
  ): string {
    if (code === 'driver_timeout') {
      switch (stage) {
        case 'com_lookup':
          return 'ATOL: не удалось завершить поиск COM-класса AddIn.Fptr10 — операция зависла.';
        case 'com_create':
          return 'ATOL: COM найден, но создание объекта Driver 10 не отвечает. Проверьте версию Driver 10 и зависшие процессы АТОЛ.';
        case 'driver_call':
          return 'ATOL: COM найден. Создание объекта Driver 10 успешно. Ответ драйвера отсутствует. Проверьте версию Driver 10 или зависший процесс АТОЛ.';
        case 'configure':
          return 'ATOL: COM OK. Driver 10 зависает на настройке USB auto.';
        case 'open':
          return 'ATOL: COM OK. Driver 10 зависает на open() ККТ.';
        case 'query':
          return 'ATOL: COM OK. ККТ открыта, но Driver 10 зависает на queryData().';
        case 'read':
          return 'ATOL: COM OK. ККТ отвечает, но Driver 10 зависает при чтении параметров.';
        case 'open_state':
          return 'ATOL: COM OK. Driver 10 зависает при проверке состояния подключения ККТ.';
        case 'close':
          return 'ATOL: операция выполнена, но Driver 10 зависает при закрытии соединения.';
        default:
          return `ATOL: Driver 10 не ответил на этапе ${stage ?? 'unknown'}.`;
      }
    }

    const stagePrefix =
      code === 'open_failed'
        ? 'ATOL: не удалось открыть ККТ'
        : code === 'query_failed'
          ? 'ATOL: ошибка чтения статуса ККТ'
          : code === 'read_failed'
            ? 'ATOL: ошибка чтения параметров ККТ'
            : code === 'configure_failed'
              ? 'ATOL: ошибка настройки USB auto'
              : undefined;
    if (stagePrefix) {
      return [stagePrefix, detail ?? message].filter(Boolean).join(': ');
    }
    return [message, detail].filter(Boolean).join(': ');
  }

  private resetTimedOutChild(
    child: ChildProcessWithoutNullStreams,
    error: Error
  ): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.failAll(error);
    try {
      child.kill();
    } catch {
      // A later request can still start a fresh helper; recovery remains authoritative.
    }
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.finishPending(id, pending, 'error', error);
    pending.reject(error);
  }

  private finishPending(
    id: string,
    pending: { command: BridgeCommand; startedAt: number },
    status: 'ok' | 'error' | 'timeout',
    error?: Error
  ): void {
    const finishedAt = Date.now();
    const durationMs = finishedAt - pending.startedAt;
    this.lastDurationMs = durationMs;
    if (error) {
      this.lastError = error.message;
    }
    this.logDiagnostics('request finished', {
      command: pending.command,
      requestId: id,
      startedAt: new Date(pending.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs,
      status,
    });
  }

  private requestForDiagnostics(request: BridgeRequest): Record<string, unknown> {
    if (request.command !== 'executeJson') {
      return request as unknown as Record<string, unknown>;
    }
    const rawJson = typeof request.args?.json === 'string' ? request.args.json : '';
    return {
      protocolVersion: request.protocolVersion,
      id: request.id,
      command: request.command,
      args: {
        json: `[redacted fiscal JSON; length=${rawJson.length}]`,
      },
    };
  }

  private pushTransport(target: string[], line: string): void {
    target.push(line);
    if (target.length > TRANSPORT_HISTORY_LIMIT) {
      target.splice(0, target.length - TRANSPORT_HISTORY_LIMIT);
    }
  }

  private logDiagnostics(message: string, data?: unknown): void {
    const suffix =
      data === undefined
        ? ''
        : `\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
    const entry = `[ATOL CLIENT] ${message}${suffix}`;
    console.log(entry);
    this.appendDiagnosticEntry(entry);
  }

  private logBridgeStderr(line: string): void {
    const entry = `[ATOL BRIDGE STDERR]\n${line}`;
    console.error(entry);
    this.appendDiagnosticEntry(entry);
  }

  private appendDiagnosticEntry(entry: string): void {
    if (this.diagnosticsFileUnavailable) {
      return;
    }
    const logPath = resolveAtolBridgeLogPath();
    if (!logPath) {
      return;
    }
    try {
      mkdirSync(join(logPath, '..'), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${entry}\n`, 'utf8');
    } catch (error) {
      this.diagnosticsFileUnavailable = true;
      console.error(
        `[ATOL CLIENT] diagnostics file write failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private failAll(error: Error): void {
    for (const [id] of this.pending) {
      this.rejectPending(id, error);
    }
  }
}
