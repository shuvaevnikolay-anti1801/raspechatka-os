import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { InpasSettings } from "../../shared/contracts";

export type InpasLauncher = {
  path: string;
  type: "jar" | "bat" | "exe";
  command: string;
  prefixArgs: string[];
};

const DEFAULT_CONSOLE: InpasSettings["console"] = {
  executablePath: "",
  terminalId: "",
  currencyCode: "643",
  timeoutMs: 3_600_000,
  qrMode: "terminal_choice",
};

export const DEFAULT_INPAS_SETTINGS: InpasSettings = {
  version: 2,
  enabled: false,
  adapter: "direct",
  direct: {},
  console: DEFAULT_CONSOLE,
};

type LegacySettings = Partial<InpasSettings["console"]> & { enabled?: boolean };

function preferredConfiguredPaths(value: string): string[] {
  if (!value.trim()) return [];
  const configured = resolve(value.trim());
  const extension = extname(configured).toLowerCase();
  if (extension !== ".jar") return [configured];
  return [
    join(dirname(configured), `${basename(configured, extension)}.bat`),
    configured,
  ];
}

export class InpasSettingsStore {
  constructor(private readonly filePath: string) {}

  load(): InpasSettings {
    if (!existsSync(this.filePath)) return this.normalize(DEFAULT_INPAS_SETTINGS);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as
        Partial<InpasSettings> & LegacySettings;
      if (parsed.version === 2) return this.normalize(parsed as Partial<InpasSettings>);
      return this.normalize({
        version: 2,
        enabled: Boolean(parsed.enabled),
        adapter: "console",
        direct: {},
        console: {
          executablePath: String(parsed.executablePath || ""),
          terminalId: String(parsed.terminalId || ""),
          currencyCode: String(parsed.currencyCode || "643"),
          timeoutMs: Number(parsed.timeoutMs) || 3_600_000,
          qrMode: "terminal_choice",
        },
      });
    } catch {
      return this.normalize(DEFAULT_INPAS_SETTINGS);
    }
  }

  save(value: Partial<InpasSettings>): InpasSettings {
    const current = this.load();
    const next = this.normalize({
      ...current,
      ...value,
      direct: { ...current.direct, ...value.direct },
      console: { ...current.console, ...value.console },
    });
    if (next.enabled && next.adapter === "direct") {
      const terminalId = next.direct?.selectedDevice?.terminalId;
      if (!terminalId || !isNumericTerminalId(terminalId))
        throw new Error("Выберите терминал INPAS, подтверждённый проверкой связи");
    }
    if (next.enabled && next.adapter === "console") {
      if (!isNumericTerminalId(next.console.terminalId))
        throw new Error("Legacy Terminal ID INPAS должен состоять из цифр");
      if (!/^\d{3}$/.test(next.console.currencyCode))
        throw new Error("Код валюты должен состоять из трёх цифр");
      const launcher = this.resolveLauncher(next);
      if (!launcher)
        throw new Error("INPAS DC Console не найден. Проверьте установку Интегратора Точки");
      next.console.executablePath = launcher.path;
    }
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf-8");
    return next;
  }

  resolveExecutable(settings = this.load()): string | undefined {
    return this.resolveLauncher(settings)?.path;
  }

  resolveLauncher(settings = this.load()): InpasLauncher | undefined {
    const configured = settings.console.executablePath.trim();
    const override = process.env.RASPECHATKA_INPAS_CONSOLE || "";
    const candidates = [
      ...preferredConfiguredPaths(configured),
      ...preferredConfiguredPaths(override),
      ...[process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
        .filter(Boolean)
        .flatMap((root) => [
          "DCConsole.bat",
          "DCCconsole.bat",
          "DCConsole.jar",
          "DCCconsole.jar",
          "DC Console.exe",
          "DCConsole.exe",
        ].map((file) => join(root!, "INPAS", "DualConnector", file))),
    ].filter(Boolean).map((item) => resolve(item));

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
          process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java.exe") : "",
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
            ).split(/\r?\n/).find(Boolean)?.trim();
          } catch {}
        }
        if (java) return { path, type: "jar", command: java, prefixArgs: ["-jar", path] };
      }
      if (extension === ".exe")
        return { path, type: "exe", command: path, prefixArgs: [] };
    }
    return undefined;
  }

  private normalize(value: Partial<InpasSettings>): InpasSettings {
    const selected = value.direct?.selectedDevice;
    return {
      version: 2,
      enabled: Boolean(value.enabled),
      adapter: value.adapter === "console" ? "console" : "direct",
      direct: {
        selectedDevice: selected && isNumericTerminalId(String(selected.terminalId))
          ? {
              terminalId: String(selected.terminalId),
              model: selected.model ? String(selected.model).slice(0, 200) : undefined,
              serial: selected.serial ? String(selected.serial).slice(0, 200) : undefined,
            }
          : undefined,
      },
      console: {
        executablePath: String(value.console?.executablePath || "").trim(),
        terminalId: String(value.console?.terminalId || "").trim(),
        currencyCode: String(value.console?.currencyCode || "643").trim(),
        timeoutMs: Math.min(
          Math.max(Number(value.console?.timeoutMs) || 3_600_000, 30_000),
          3_600_000
        ),
        qrMode: "terminal_choice",
      },
    };
  }
}

export function isNumericTerminalId(value: string | undefined): value is string {
  return Boolean(value && /^\d{1,32}$/.test(value));
}

export function collectInpasTerminalCandidates(
  settings: InpasSettings,
  legacyResultDirectory?: string
): string[] {
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    const terminalId = typeof value === "string" ? value.trim() : "";
    if (isNumericTerminalId(terminalId)) candidates.add(terminalId);
  };
  add(settings.direct?.selectedDevice?.terminalId);
  add(settings.console.terminalId);

  const resultFiles: string[] = [];
  if (settings.console.executablePath) {
    resultFiles.push(join(dirname(settings.console.executablePath), "result.txt"));
  }
  if (legacyResultDirectory && existsSync(legacyResultDirectory)) {
    try {
      resultFiles.push(...readdirSync(legacyResultDirectory)
        .filter((name) => name.toLowerCase().endsWith(".json"))
        .map((name) => join(legacyResultDirectory, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
        .slice(0, 20));
    } catch {}
  }

  for (const path of resultFiles) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf-8");
      if (path.toLowerCase().endsWith(".json")) {
        const stored = JSON.parse(text) as {
          status?: unknown;
          raw?: { fields?: Record<string, unknown> };
        };
        if (stored.status === "approved") add(stored.raw?.fields?.["27"]);
      } else {
        const fields = safeResultFields(text);
        if (fields["39"] === "1" || fields["39"] === "00") add(fields["27"]);
      }
    } catch {}
  }
  return [...candidates];
}

function safeResultFields(text: string): Record<string, string> {
  const allowed = new Set(["27", "39"]);
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\[(\d+)]\s*=\s*['"]?(.*?)['"]?\s*$/);
    if (match && allowed.has(match[1])) fields[match[1]] = match[2].trim();
  }
  return fields;
}
