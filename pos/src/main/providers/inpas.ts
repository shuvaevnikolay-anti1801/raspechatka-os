import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  InpasSettings,
  PaymentServiceResult,
} from "../../shared/contracts";
import type {
  DeviceHealth,
  PaymentProvider,
  PaymentRequest,
  PaymentResult,
} from "./contracts";

type CommandResult = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type CommandExecutor = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    windowsVerbatimArguments?: boolean;
  }
) => Promise<CommandResult>;

export type InpasLauncher = {
  path: string;
  type: "jar" | "bat" | "exe";
  command: string;
  prefixArgs: string[];
};

function isLegacyDcConsoleExe(launcher: InpasLauncher): boolean {
  return (
    launcher.type === "exe" &&
    basename(launcher.path).toLowerCase() === "dc console.exe"
  );
}

const DEFAULT_SETTINGS: InpasSettings = {
  enabled: false,
  executablePath: "",
  terminalId: "",
  currencyCode: "643",
  timeoutMs: 3_600_000,
  qrMode: "terminal_choice",
};

const decode = (buffer: Buffer) =>
  new TextDecoder("windows-1251").decode(buffer).replace(/^\uFEFF/, "");

const decodeConsole = (buffer: Buffer) =>
  new TextDecoder(process.platform === "win32" ? "ibm866" : "utf-8")
    .decode(buffer)
    .replace(/^\uFEFF/, "");

export function resolveInpasConsoleLogPath(): string | undefined {
  const appData = process.env.APPDATA;
  return appData
    ? join(appData, "Kassa-Raspechatka", "logs", "inpas-console.log")
    : undefined;
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/\b\d{12,19}\b/g, (digits) =>
      `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
    )
    .slice(0, 8000);
}

export function parseInpasResult(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\[(\d+)]\s*=\s*['"]?(.*?)['"]?\s*$/);
    if (match) fields[match[1].padStart(2, "0")] = match[2];
  }
  return fields;
}

function preferredConfiguredPaths(value: string): string[] {
  if (!value.trim()) return [];
  const configured = resolve(value.trim());
  const extension = extname(configured).toLowerCase();
  if (extension !== ".jar") return [configured];

  // DualConnector 2.x ships an official BAT wrapper next to the JAR. The BAT
  // establishes the expected working directory/classpath before starting Java.
  // Older Raspechatka builds persisted DCConsole.jar in settings, so prefer the
  // sibling BAT automatically without requiring the cashier to reconfigure POS.
  const siblingBat = join(
    dirname(configured),
    `${basename(configured, extension)}.bat`
  );
  return [siblingBat, configured];
}

export class InpasSettingsStore {
  constructor(private readonly filePath: string) {}

  load(): InpasSettings {
    if (!existsSync(this.filePath)) return { ...DEFAULT_SETTINGS };
    try {
      return this.normalize({
        ...DEFAULT_SETTINGS,
        ...(JSON.parse(
          readFileSync(this.filePath, "utf-8")
        ) as Partial<InpasSettings>),
      });
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  save(value: Partial<InpasSettings>): InpasSettings {
    const next = this.normalize({ ...this.load(), ...value });
    if (next.enabled) {
      if (!next.terminalId) throw new Error("Укажите ID терминала INPAS");
      if (!/^[A-Za-z0-9_-]+$/.test(next.terminalId))
        throw new Error("ID терминала содержит недопустимые символы");
      if (!/^\d{3}$/.test(next.currencyCode))
        throw new Error("Код валюты должен состоять из трёх цифр");
      // Production uses the registered DualConnector COM bridge and does not
      // require DC Console to be installed. Preserve a discovered console path
      // only for the explicit hidden legacy fallback.
      const launcher = this.resolveLauncher(next);
      next.executablePath = launcher?.path ?? "";
    }
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf-8");
    return next;
  }

  resolveExecutable(settings = this.load()): string | undefined {
    return this.resolveLauncher(settings)?.path;
  }

  resolveLauncher(settings = this.load()): InpasLauncher | undefined {
    const configured = settings.executablePath.trim();
    const override = process.env.RASPECHATKA_INPAS_CONSOLE || "";
    const candidates = [
      ...preferredConfiguredPaths(configured),
      ...preferredConfiguredPaths(override),
      ...[process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
        .filter(Boolean)
        .flatMap((root) =>
          [
            "DCConsole.bat",
            "DCCconsole.bat",
            "DCConsole.jar",
            "DCCconsole.jar",
            "DC Console.exe",
            "DCConsole.exe",
          ].map((file) => join(root!, "INPAS", "DualConnector", file))
        ),
    ]
      .filter(Boolean)
      .map((item) => resolve(item));

    for (const path of [...new Set(candidates)]) {
      if (!existsSync(path)) continue;
      const extension = extname(path).toLowerCase();

      if (extension === ".bat") {
        return {
          path,
          type: "bat",
          command: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
          prefixArgs: ["/d", "/s", "/c"],
        };
      }

      if (extension === ".jar") {
        const bundled = [
          process.env.JAVA_HOME
            ? join(process.env.JAVA_HOME, "bin", "java.exe")
            : "",
          join(dirname(path), "jre", "bin", "java.exe"),
          join(dirname(path), "runtime", "bin", "java.exe"),
        ].find((item) => item && existsSync(item));
        let java = bundled;
        if (!java) {
          try {
            java = execFileSync(
              process.platform === "win32" ? "where.exe" : "which",
              [process.platform === "win32" ? "java.exe" : "java"],
              { encoding: "utf8", windowsHide: true }
            )
              .split(/\r?\n/)
              .find(Boolean)
              ?.trim();
          } catch {}
        }
        if (java)
          return {
            path,
            type: "jar",
            command: java,
            prefixArgs: ["-jar", path],
          };
      }

      if (extension === ".exe")
        return { path, type: "exe", command: path, prefixArgs: [] };
    }
    return undefined;
  }

  private normalize(value: InpasSettings): InpasSettings {
    return {
      enabled: Boolean(value.enabled),
      executablePath: String(value.executablePath || "").trim(),
      terminalId: String(value.terminalId || "").trim(),
      currencyCode: String(value.currencyCode || "643").trim(),
      timeoutMs: Math.min(
        Math.max(Number(value.timeoutMs) || 3_600_000, 30_000),
        3_600_000
      ),
      qrMode: "terminal_choice",
    };
  }
}

export class InpasPaymentProvider implements PaymentProvider {
  private running = false;
  private healthCache: { at: number; value: DeviceHealth } | undefined;
  private diagnosticsFileUnavailable = false;

  constructor(
    private readonly settingsStore: InpasSettingsStore,
    private readonly resultDirectory: string,
    private readonly executor: CommandExecutor = executeCommand
  ) {
    mkdirSync(resultDirectory, { recursive: true });
  }

  settingsChanged(): void {
    this.healthCache = undefined;
  }

  healthCheck(): Promise<DeviceHealth> {
    return this.checkHealth(false);
  }

  private async checkHealth(force: boolean): Promise<DeviceHealth> {
    const settings = this.settingsStore.load();
    if (!settings.enabled)
      return {
        ready: false,
        status: "not_configured",
        message: "INPAS / PAX не включён в настройках",
      };
    if (this.running)
      return {
        ready: false,
        status: "busy",
        message: "Терминал выполняет операцию",
      };
    if (!force && this.healthCache && Date.now() - this.healthCache.at < 30_000)
      return this.healthCache.value;

    const launcher = this.settingsStore.resolveLauncher(settings);
    if (!launcher)
      return {
        ready: false,
        status: "not_configured",
        message:
          "INPAS Dual Connector / DC Console не найден. Проверьте установку DualConnector 2.0",
      };
    if (!settings.terminalId)
      return {
        ready: false,
        status: "not_configured",
        message: "Не указан ID терминала INPAS",
      };

    try {
      const result = await this.run(
        "health",
        `health-${Date.now()}`,
        undefined,
        settings
      );
      const health: DeviceHealth =
        result.status === "approved"
          ? {
              ready: true,
              status: "ready",
              message: "INPAS / PAX готов",
              details: {
                terminalId: settings.terminalId,
                launcher: launcher.path,
                launcherType: launcher.type,
              },
            }
          : {
              ready: false,
              status: "offline",
              message: result.message || "Терминал не ответил",
              details: { terminalId: settings.terminalId },
            };
      this.healthCache = { at: Date.now(), value: health };
      return health;
    } catch (error) {
      const health: DeviceHealth = {
        ready: false,
        status: "offline",
        message: error instanceof Error ? error.message : String(error),
      };
      this.healthCache = { at: Date.now(), value: health };
      return health;
    }
  }

  charge(request: PaymentRequest): Promise<PaymentResult> {
    return this.run("charge", request.operationId, request.amountMinor);
  }

  async refund(_request: PaymentRequest): Promise<PaymentResult> {
    return {
      status: "declined",
      message:
        "Legacy INPAS refund отключён: operation 4 является void, а не возвратом. Используйте прямой INPAS adapter.",
    };
  }

  async getOperationStatus(request: PaymentRequest): Promise<PaymentResult> {
    const stored = this.readStoredResult(request.operationId);
    return (
      stored ?? {
        status: "unknown",
        message:
          "DCConsole не поддерживает безопасный запрос статуса по ID. Проверьте чек терминала и банковский журнал.",
      }
    );
  }

  async reconcile(): Promise<PaymentServiceResult> {
    const operationId = `reconcile-${Date.now()}`;
    const result = await this.run("reconcile", operationId, undefined);
    if (result.status !== "approved")
      throw new Error(result.message || "Сверка итогов INPAS не выполнена");
    return {
      message: "Сверка итогов INPAS выполнена",
      receipt: (result.raw as any)?.receipt,
      raw: result.raw,
    };
  }

  async testConnection(): Promise<PaymentServiceResult> {
    const health = await this.checkHealth(true);
    if (!health.ready) throw new Error(health.message);
    return { message: health.message, raw: health.details };
  }

  private async run(
    kind: "charge" | "health" | "reconcile",
    operationId: string,
    amountMinor?: number,
    provided?: InpasSettings
  ): Promise<PaymentResult> {
    if (this.running) throw new Error("Терминал уже выполняет другую операцию");
    const settings = provided ?? this.settingsStore.load();
    if (!settings.enabled)
      throw new Error("Эквайринг INPAS выключен в настройках");

    const launcher = this.settingsStore.resolveLauncher(settings);
    if (!launcher)
      throw new Error(
        "INPAS Dual Connector / DC Console не найден. Проверьте установку DualConnector 2.0"
      );
    if (!settings.terminalId) throw new Error("Не указан ID терминала INPAS");

    const operationCode = {
      charge: "1",
      health: "26",
      reconcile: "59",
    }[kind];
    const legacyExe = isLegacyDcConsoleExe(launcher);
    // DualConnector 1.x uses "DC Console.exe" and a legacy CLI shape.
    // Keep this special case read-only until monetary operations are verified
    // against real PAX hardware. Modern DCConsole.bat/jar arguments stay intact.
    const legacyReadOnly = legacyExe && (kind === "health" || kind === "reconcile");
    const args = legacyReadOnly
      ? [
          "-p5",
          `-z${settings.terminalId}`,
          `-o${operationCode}`,
          "-m22",
          "-l1",
        ]
      : [`-o${operationCode}`, `-z${settings.terminalId}`];
    if (!legacyReadOnly) {
      if (amountMinor !== undefined) args.push(`-a${amountMinor}`);
      if (kind === "charge") args.push(`-c${settings.currencyCode}`);
      args.push(`-s${Math.ceil(settings.timeoutMs / 1000)}`);
    }

    const cwd = dirname(launcher.path);
    const resultPath = join(cwd, "result.txt");
    const receiptPath = join(cwd, "receipt.txt");
    const launchArgs =
      launcher.type === "bat"
        ? [
            ...launcher.prefixArgs,
            `call "${launcher.path}" ${args.join(" ")}`,
          ]
        : [...launcher.prefixArgs, ...args];
    const timeoutMs = settings.timeoutMs + 5000;
    // Node normally applies C-runtime quoting to child arguments on Windows.
    // cmd.exe does not understand the resulting backslash-escaped quotes in
    // a /c command string, so BAT launchers must receive their arguments
    // verbatim. Otherwise a path such as "C:\Program Files (x86)\..."
    // reaches cmd.exe as a quoted literal and DCConsole.bat is never started.
    const windowsVerbatimArguments = launcher.type === "bat";
    const startedAt = Date.now();
    let cwdWritable = true;
    try {
      accessSync(cwd, constants.W_OK);
    } catch {
      cwdWritable = false;
    }

    this.logDiagnostics("command start", {
      kind,
      operationCode,
      launcherType: launcher.type,
      launcherMode: legacyExe ? "legacy-exe" : "modern-console",
      launcherPath: launcher.path,
      command: launcher.command,
      launchArgs,
      cwd,
      cwdWritable,
      resultPath,
      receiptPath,
      timeoutMs,
      windowsVerbatimArguments,
      terminalId: settings.terminalId,
      currencyCode: settings.currencyCode,
      amountMinor,
      startedAt: new Date(startedAt).toISOString(),
    });

    this.running = true;
    try {
      rmSync(resultPath, { force: true });
      rmSync(receiptPath, { force: true });
      this.logDiagnostics("stale files cleared", { resultPath, receiptPath });

      let processResult: CommandResult;
      try {
        processResult = await this.executor(launcher.command, launchArgs, {
          cwd,
          timeoutMs,
          windowsVerbatimArguments,
        });
      } catch (error) {
        this.logDiagnostics("process launch failed", {
          kind,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const resultFileFound = existsSync(resultPath);
      const fields = resultFileFound
        ? parseInpasResult(decode(readFileSync(resultPath)))
        : {};
      const receipt = existsSync(receiptPath)
        ? decode(readFileSync(receiptPath)).trim()
        : "";
      const stdout = processResult.stdout.trim().slice(0, 1500);
      const stderr = processResult.stderr.trim().slice(0, 1500);
      const raw = {
        kind,
        launcherType: launcher.type,
        launcher: basename(launcher.path),
        launcherPath: launcher.path,
        exitCode: processResult.code,
        signal: processResult.signal,
        statusCode: fields["39"],
        resultFileFound,
        fields: this.safeFields(fields),
        receipt: receipt || undefined,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };

      this.logDiagnostics("command finished", {
        kind,
        durationMs: Date.now() - startedAt,
        exitCode: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        resultFileFound,
        receiptFileFound: existsSync(receiptPath),
        statusCode: fields["39"],
        fields: this.safeFields(fields),
        stdout: stdout ? sanitizeDiagnosticText(stdout) : undefined,
        stderr: stderr ? sanitizeDiagnosticText(stderr) : undefined,
      });

      let paymentResult: PaymentResult;
      if (processResult.timedOut || processResult.signal) {
        paymentResult = {
          status: "unknown",
          message: "Операция INPAS прервана или превысила время ожидания",
          raw,
        };
      } else if (fields["39"] === "1") {
        paymentResult = {
          status: "approved",
          transactionId: this.transactionId(operationId, fields, receipt),
          message: this.resultMessage(fields) || "Операция подтверждена",
          raw,
        };
      } else if (fields["39"] && fields["39"] !== "1") {
        paymentResult = {
          status: "declined",
          message:
            this.resultMessage(fields) ||
            stderr ||
            stdout ||
            `INPAS вернул код ${processResult.code}`,
          raw,
        };
      } else if (!resultFileFound) {
        const detail = stderr || stdout;
        this.logDiagnostics("result.txt missing", {
          kind,
          cwd,
          cwdWritable,
          resultPath,
          exitCode: processResult.code,
          signal: processResult.signal,
          stdout: stdout ? sanitizeDiagnosticText(stdout) : undefined,
          stderr: stderr ? sanitizeDiagnosticText(stderr) : undefined,
        });
        paymentResult = {
          status: "unknown",
          message: detail
            ? `DC Console не создал result.txt: ${detail}`
            : `DC Console не создал result.txt (launcher ${basename(
                launcher.path
              )}, exit ${processResult.code ?? "null"})`,
          raw,
        };
      } else {
        paymentResult = {
          status: "unknown",
          message:
            this.resultMessage(fields) ||
            "DC Console вернул result.txt без подтверждённого банковского результата [39]",
          raw,
        };
      }

      if (kind === "charge") this.storeResult(operationId, paymentResult);
      return paymentResult;
    } finally {
      this.running = false;
    }
  }

  private logDiagnostics(message: string, data?: unknown): void {
    const suffix =
      data === undefined
        ? ""
        : `\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`;
    const entry = `[INPAS CONSOLE] ${message}${suffix}`;
    console.log(entry);

    if (this.diagnosticsFileUnavailable) return;
    const logPath = resolveInpasConsoleLogPath();
    if (!logPath) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${entry}\n`, "utf8");
    } catch (error) {
      this.diagnosticsFileUnavailable = true;
      console.error(
        `[INPAS CONSOLE] diagnostics file write failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private resultMessage(fields: Record<string, string>): string | undefined {
    return ["19", "64", "65", "70", "01"]
      .map((key) => fields[key])
      .find(Boolean);
  }

  private safeFields(fields: Record<string, string>): Record<string, string> {
    const allowed = new Set([
      "00",
      "01",
      "12",
      "13",
      "14",
      "19",
      "25",
      "26",
      "27",
      "31",
      "39",
      "59",
      "64",
      "65",
      "70",
    ]);
    return Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => allowed.has(key))
        .map(([key, value]) => [
          key,
          key === "04"
            ? value.replace(/\d(?=\d{4})/g, "*")
            : value.slice(0, 500),
        ])
    );
  }

  private transactionId(
    operationId: string,
    fields: Record<string, string>,
    receipt: string
  ): string {
    const bankReference = ["12", "13", "14", "25"]
      .map((key) => fields[key])
      .find(Boolean);
    if (bankReference) return `INPAS-${bankReference}`;
    return `INPAS-${createHash("sha256")
      .update(
        `${operationId}\n${JSON.stringify(this.safeFields(fields))}\n${receipt}`
      )
      .digest("hex")
      .slice(0, 24)}`;
  }

  private resultFile(operationId: string): string {
    return join(
      this.resultDirectory,
      `${operationId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`
    );
  }

  private storeResult(operationId: string, result: PaymentResult): void {
    const path = this.resultFile(operationId);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(result), "utf-8");
    renameSync(temporary, path);
  }

  private readStoredResult(operationId: string): PaymentResult | undefined {
    const path = this.resultFile(operationId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as PaymentResult;
    } catch {
      return undefined;
    }
  }
}

function executeCommand(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    windowsVerbatimArguments?: boolean;
  }
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
        timeout: options.timeoutMs,
        encoding: "buffer",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const processError = error as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
          signal?: string;
        };
        if (
          error &&
          typeof processError.code === "string" &&
          processError.code !== "ETIMEDOUT"
        )
          return reject(error);
        resolvePromise({
          code: error
            ? typeof processError.code === "number"
              ? processError.code
              : null
            : 0,
          signal: processError?.signal ?? null,
          stdout: decodeConsole(Buffer.from(stdout || [])),
          stderr: decodeConsole(Buffer.from(stderr || [])),
          timedOut: Boolean(
            processError?.killed || processError?.code === "ETIMEDOUT"
          ),
        });
      }
    );
  });
}
