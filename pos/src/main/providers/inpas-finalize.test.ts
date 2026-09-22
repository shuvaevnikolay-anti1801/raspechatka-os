import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InpasPaymentProvider, InpasSettingsStore } from "./inpas";

const originalEnv = {
  programFilesX86: process.env["ProgramFiles(x86)"],
  programFiles: process.env.ProgramFiles,
  javaHome: process.env.JAVA_HOME,
  consoleOverride: process.env.RASPECHATKA_INPAS_CONSOLE,
  comSpec: process.env.ComSpec,
};

function restoreEnv(): void {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("ProgramFiles(x86)", originalEnv.programFilesX86);
  restore("ProgramFiles", originalEnv.programFiles);
  restore("JAVA_HOME", originalEnv.javaHome);
  restore("RASPECHATKA_INPAS_CONSOLE", originalEnv.consoleOverride);
  restore("ComSpec", originalEnv.comSpec);
}

afterEach(() => restoreEnv());

function inpasSettings(executablePath = "") {
  return {
    enabled: true,
    executablePath,
    terminalId: "40000037",
    currencyCode: "643",
    timeoutMs: 60_000,
    qrMode: "terminal_choice" as const,
  };
}

describe("INPAS launcher discovery", () => {
  it("auto-discovers DCConsole.jar when BAT is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "raspechatka-inpas-programfiles-"));
    try {
      const connector = join(root, "INPAS", "DualConnector");
      const jar = join(connector, "DCConsole.jar");
      const java = join(connector, "jre", "bin", "java.exe");
      mkdirSync(join(connector, "jre", "bin"), { recursive: true });
      writeFileSync(jar, "jar");
      writeFileSync(java, "java");
      process.env["ProgramFiles(x86)"] = root;
      process.env.ProgramFiles = "";
      delete process.env.JAVA_HOME;
      delete process.env.RASPECHATKA_INPAS_CONSOLE;

      const store = new InpasSettingsStore(join(root, "settings.json"));
      expect(store.resolveLauncher(inpasSettings())).toEqual({
        path: jar,
        type: "jar",
        command: java,
        prefixArgs: ["-jar", jar],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts DCCconsole.jar as a compatibility launcher name", () => {
    const root = mkdtempSync(join(tmpdir(), "raspechatka-inpas-altname-"));
    try {
      const connector = join(root, "INPAS", "DualConnector");
      const jar = join(connector, "DCCconsole.jar");
      const java = join(connector, "jre", "bin", "java.exe");
      mkdirSync(join(connector, "jre", "bin"), { recursive: true });
      writeFileSync(jar, "jar");
      writeFileSync(java, "java");
      process.env["ProgramFiles(x86)"] = root;
      process.env.ProgramFiles = "";
      delete process.env.JAVA_HOME;
      delete process.env.RASPECHATKA_INPAS_CONSOLE;

      const store = new InpasSettingsStore(join(root, "settings.json"));
      expect(store.resolveLauncher(inpasSettings())?.path).toBe(jar);
      expect(store.resolveLauncher(inpasSettings())?.type).toBe("jar");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the standard DCConsole.bat", () => {
    const root = mkdtempSync(join(tmpdir(), "raspechatka-inpas-bat-"));
    try {
      const connector = join(root, "INPAS", "DualConnector");
      const bat = join(connector, "DCConsole.bat");
      mkdirSync(connector, { recursive: true });
      writeFileSync(bat, "@echo off");
      process.env["ProgramFiles(x86)"] = root;
      process.env.ProgramFiles = "";
      delete process.env.JAVA_HOME;
      delete process.env.RASPECHATKA_INPAS_CONSOLE;
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

      const store = new InpasSettingsStore(join(root, "settings.json"));
      expect(store.resolveLauncher(inpasSettings())).toEqual({
        path: bat,
        type: "bat",
        command: "C:\\Windows\\System32\\cmd.exe",
        prefixArgs: ["/d", "/s", "/c"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps compatibility with legacy DC Console.exe", () => {
    const root = mkdtempSync(join(tmpdir(), "raspechatka-inpas-exe-"));
    try {
      const connector = join(root, "INPAS", "DualConnector");
      const exe = join(connector, "DC Console.exe");
      mkdirSync(connector, { recursive: true });
      writeFileSync(exe, "exe");
      process.env["ProgramFiles(x86)"] = root;
      process.env.ProgramFiles = "";
      delete process.env.RASPECHATKA_INPAS_CONSOLE;

      const store = new InpasSettingsStore(join(root, "settings.json"));
      expect(store.resolveLauncher(inpasSettings())).toEqual({
        path: exe,
        type: "exe",
        command: exe,
        prefixArgs: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when no supported launcher exists", () => {
    const root = mkdtempSync(join(tmpdir(), "raspechatka-inpas-missing-"));
    try {
      process.env["ProgramFiles(x86)"] = root;
      process.env.ProgramFiles = root;
      delete process.env.JAVA_HOME;
      delete process.env.RASPECHATKA_INPAS_CONSOLE;

      const store = new InpasSettingsStore(join(root, "settings.json"));
      expect(store.resolveLauncher(inpasSettings())).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("INPAS runner final result contract", () => {
  it("launches JAR through java -jar and treats SA [39]=1 as authoritative", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raspechatka-inpas-jar-run-"));
    try {
      const jar = join(directory, "OnlyConsole.jar");
      const java = join(directory, "jre", "bin", "java.exe");
      mkdirSync(join(directory, "jre", "bin"), { recursive: true });
      writeFileSync(jar, "jar");
      writeFileSync(java, "java");
      process.env.JAVA_HOME = "";

      const settings = new InpasSettingsStore(join(directory, "settings.json"));
      settings.save(inpasSettings(jar));
      const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
      const provider = new InpasPaymentProvider(
        settings,
        join(directory, "results"),
        async (file, args, options) => {
          calls.push({ file, args, cwd: options.cwd });
          writeFileSync(
            join(options.cwd, "result.txt"),
            "[12] = 'RRN-REAL'\r\n[39] = '1'\r\n[19] = 'APPROVED'",
            "latin1"
          );
          return {
            code: 7,
            signal: null,
            stdout: "",
            stderr: "technical launcher exit",
            timedOut: false,
          };
        }
      );

      const result = await provider.charge({
        operationId: "sale-approved",
        saleId: "sale-1",
        amountMinor: 12345,
        method: "card",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe(java);
      expect(calls[0].cwd).toBe(directory);
      expect(calls[0].args).toEqual([
        "-jar",
        jar,
        "-o1",
        "-z40000037",
        "-a12345",
        "-c643",
        "-s60",
      ]);
      expect(result).toMatchObject({
        status: "approved",
        transactionId: "INPAS-RRN-REAL",
      });
      expect((result.raw as any).exitCode).toBe(7);
      expect((result.raw as any).statusCode).toBe("1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("launches BAT through cmd.exe CALL with one command string", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raspechatka-inpas-bat-run-"));
    try {
      const bat = join(directory, "DCConsole.bat");
      writeFileSync(bat, "@echo off");
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

      const settings = new InpasSettingsStore(join(directory, "settings.json"));
      settings.save(inpasSettings(bat));
      const calls: Array<{ file: string; args: string[] }> = [];
      const provider = new InpasPaymentProvider(
        settings,
        join(directory, "results"),
        async (file, args, options) => {
          calls.push({ file, args });
          writeFileSync(
            join(options.cwd, "result.txt"),
            "[39] = '1'\r\n[19] = 'OK'",
            "latin1"
          );
          return {
            code: 0,
            signal: null,
            stdout: "",
            stderr: "",
            timedOut: false,
          };
        }
      );

      expect((await provider.healthCheck()).ready).toBe(true);
      expect(calls[0].file).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(calls[0].args).toEqual([
        "/d",
        "/s",
        "/c",
        `call "${bat}" -o26 -z40000037 -s60`,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
