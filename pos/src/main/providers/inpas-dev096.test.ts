import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InpasPaymentProvider, InpasSettingsStore } from "./inpas";

const originalEnv = {
  programFilesX86: process.env["ProgramFiles(x86)"],
  programFiles: process.env.ProgramFiles,
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
  restore("RASPECHATKA_INPAS_CONSOLE", originalEnv.consoleOverride);
  restore("ComSpec", originalEnv.comSpec);
}

afterEach(() => restoreEnv());

function settings(executablePath = "") {
  return {
    enabled: true,
    executablePath,
    terminalId: "40000037",
    currencyCode: "643",
    timeoutMs: 360_000,
    qrMode: "terminal_choice" as const,
  };
}

describe("DEV-096 INPAS BAT launcher", () => {
  it("prefers DCConsole.bat when BAT and JAR are installed together", () => {
    const root = mkdtempSync(join(tmpdir(), "raspechatka-inpas-dev096-"));
    try {
      const connector = join(root, "INPAS", "DualConnector");
      const bat = join(connector, "DCConsole.bat");
      const jar = join(connector, "DCConsole.jar");
      mkdirSync(connector, { recursive: true });
      writeFileSync(bat, "@echo off");
      writeFileSync(jar, "jar");
      process.env["ProgramFiles(x86)"] = root;
      process.env.ProgramFiles = "";
      delete process.env.RASPECHATKA_INPAS_CONSOLE;
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

      const store = new InpasSettingsStore(join(root, "settings.json"));
      expect(store.resolveLauncher(settings())).toEqual({
        path: bat,
        type: "bat",
        command: "C:\\Windows\\System32\\cmd.exe",
        prefixArgs: ["/d", "/s", "/c"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates an already persisted DCConsole.jar setting to its sibling BAT", () => {
    const root = mkdtempSync(join(tmpdir(), "raspechatka-inpas-dev096-saved-"));
    try {
      const bat = join(root, "DCConsole.bat");
      const jar = join(root, "DCConsole.jar");
      writeFileSync(bat, "@echo off");
      writeFileSync(jar, "jar");
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

      const store = new InpasSettingsStore(join(root, "settings.json"));
      expect(store.resolveLauncher(settings(jar))?.path).toBe(bat);
      expect(store.resolveLauncher(settings(jar))?.type).toBe("bat");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invokes BAT through cmd CALL using the official INPAS argument shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "raspechatka-inpas-dev096-call-"));
    try {
      const bat = join(root, "DCConsole.bat");
      writeFileSync(bat, "@echo off");
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

      const store = new InpasSettingsStore(join(root, "settings.json"));
      store.save(settings(bat));
      const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
      const provider = new InpasPaymentProvider(
        store,
        join(root, "results"),
        async (file, args, options) => {
          calls.push({ file, args, cwd: options.cwd });
          writeFileSync(
            join(options.cwd, "result.txt"),
            "[27] = '40000037'\r\n[39] = '1'\r\n[19] = 'OK'",
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
      expect(calls).toEqual([
        {
          file: "C:\\Windows\\System32\\cmd.exe",
          args: [
            "/d",
            "/s",
            "/c",
            `call "${bat}" -o26 -z40000037 -a10 -c643 -s360`,
          ],
          cwd: root,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns DC Console output when result.txt was not created", async () => {
    const root = mkdtempSync(join(tmpdir(), "raspechatka-inpas-dev096-diag-"));
    try {
      const bat = join(root, "DCConsole.bat");
      writeFileSync(bat, "@echo off");
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

      const store = new InpasSettingsStore(join(root, "settings.json"));
      store.save(settings(bat));
      const provider = new InpasPaymentProvider(
        store,
        join(root, "results"),
        async () => ({
          code: 1,
          signal: null,
          stdout: "Java version 1.8.0_221",
          stderr: "Отсутствует обязательный параметр",
          timedOut: false,
        })
      );

      const health = await provider.healthCheck();
      expect(health.ready).toBe(false);
      expect(health.message).toContain("DC Console не создал result.txt");
      expect(health.message).toContain("Отсутствует обязательный параметр");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
