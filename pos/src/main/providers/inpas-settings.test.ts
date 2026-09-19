import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectInpasTerminalCandidates,
  InpasSettingsStore,
} from "./inpas-settings";

const folders: string[] = [];
const folder = () => {
  const value = mkdtempSync(join(tmpdir(), "raspechatka-inpas-settings-"));
  folders.push(value);
  return value;
};

afterEach(() => {
  for (const value of folders.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("InpasSettingsStore", () => {
  it("defaults new installations to the direct adapter", () => {
    const dir = folder();
    expect(new InpasSettingsStore(join(dir, "settings.json")).load()).toMatchObject({
      version: 2,
      enabled: false,
      adapter: "direct",
      direct: {},
    });
  });

  it("migrates legacy console settings without losing values", () => {
    const dir = folder();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({
      enabled: true,
      executablePath: "C:\\INPAS\\DC Console.exe",
      terminalId: "40000037",
      currencyCode: "643",
      timeoutMs: 120000,
      qrMode: "terminal_choice",
    }));
    expect(new InpasSettingsStore(path).load()).toMatchObject({
      version: 2,
      enabled: true,
      adapter: "console",
      console: {
        executablePath: "C:\\INPAS\\DC Console.exe",
        terminalId: "40000037",
        currencyCode: "643",
        timeoutMs: 120000,
      },
    });
  });

  it("extracts only a confirmed numeric field 27 from legacy results", () => {
    const dir = folder();
    const results = join(dir, "results");
    mkdirSync(results);
    writeFileSync(join(results, "approved.json"), JSON.stringify({
      status: "approved",
      raw: {
        fields: {
          "27": "40000037",
          "39": "1",
          "04": "4111111111111111",
          "track": "secret",
        },
      },
    }));
    const settings = new InpasSettingsStore(join(dir, "missing.json")).load();
    expect(collectInpasTerminalCandidates(settings, results)).toEqual(["40000037"]);
  });
});
