import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DeviceHealth } from './contracts';
import type {
  AtolDriverBridge,
  AtolDriverDevice,
  AtolDriverInfo,
  AtolDriverStatus,
} from './atol-driver';

const PROTOCOL_VERSION = 1;
const READ_ONLY_TIMEOUT_MS = 10_000;

type BridgeCommand =
  | 'driverInfo'
  | 'discover'
  | 'connect'
  | 'disconnect'
  | 'status'
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
  };
};

export type AtolDriverInfo = {
  installed: boolean;
  version?: string;
  architecture?: "x64" | "x86";
  error?: string;
};

export type NativeAtolDriverBridgeOptions = {
  executablePath: string;
  args?: string[];
  readOnlyTimeoutMs?: number;
};

export class NativeAtolDriverBridge implements AtolDriverBridge {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeout?: NodeJS.Timeout;
    }
  >();
  private nextId = 1;
  private stopped = false;

  constructor(private readonly options: NativeAtolDriverBridgeOptions) {}

  async getDriverInfo(): Promise<AtolDriverInfo> {
    return this.request<AtolDriverInfo>('driverInfo');
  }

  async driverInfo(): Promise<AtolDriverInfo> {
    return this.request<AtolDriverInfo>("driverInfo");
  }

  async status(): Promise<AtolDriverStatus> {
    return this.request<AtolDriverStatus>("status");
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
      const ready =
        status.connected &&
        status.paperPresent !== false &&
        !status.coverOpened &&
        !status.printerConnectionLost &&
        !status.printerError &&
        status.fnPresent !== false &&
        !status.invalidFn &&
        !status.deviceBlocked;

      return {
        ready,
        status: ready ? 'ready' : 'error',
        message: ready
          ? 'АТОЛ подключён'
          : status.errorDescription ?? 'АТОЛ требует внимания',
      } as DeviceHealth;
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

    return new Promise<T>((resolve, reject) => {
      const entry: {
        resolve: (value: unknown) => void;
        reject: (reason: Error) => void;
        timeout?: NodeJS.Timeout;
      } = { resolve, reject };

      if (command === 'driverInfo' || command === 'discover' || command === 'status') {
        entry.timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ATOL bridge timed out while running ${command}`));
        }, this.options.readOnlyTimeoutMs ?? READ_ONLY_TIMEOUT_MS);
      }

      this.pending.set(id, entry);
      child.stdin.write(`${JSON.stringify(request)}\\n`, (error) => {
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

    const child = spawn(this.options.executablePath, this.options.args ?? [], {
      shell: false,
      windowsHide: true,
    });
    this.child = child;

    createInterface({ input: child.stdout }).on('line', (line) => {
      this.handleResponse(line);
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      console.error(`[atol-bridge] ${line}`);
    });
    child.on('error', (error) => this.failAll(error));
    child.on('exit', (code, signal) => {
      this.child = undefined;
      this.stopped = true;
      this.failAll(
        new Error(
          `ATOL bridge exited${code === null ? '' : ` with code ${code}`}${
            signal ? ` (${signal})` : ''
          }`
        )
      );
    });

    return child;
  }

  private handleResponse(line: string): void {
    let response: BridgeResponse<unknown>;
    try {
      response = JSON.parse(line) as BridgeResponse<unknown>;
    } catch {
      console.error(`[atol-bridge] invalid protocol line: ${line}`);
      return;
    }

    if (response.protocolVersion !== PROTOCOL_VERSION || !response.id) {
      console.error('[atol-bridge] invalid protocol response');
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
      pending.resolve(response.result);
      return;
    }

    const detail = response.error?.driverErrorDescription;
    pending.reject(
      new Error(
        [response.error?.message ?? 'ATOL bridge request failed', detail]
          .filter(Boolean)
          .join(': ')
      )
    );
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
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const [id] of this.pending) {
      this.rejectPending(id, error);
    }
  }
}
