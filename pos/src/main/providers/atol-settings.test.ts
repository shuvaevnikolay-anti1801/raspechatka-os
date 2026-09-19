import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtolSettingsStore } from "./atol-settings";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "raspechatka-atol-settings-"));
  dirs.push(dir);
  return join(dir, "atol.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AtolSettingsStore", () => {
  it("defaults new installations to the direct driver adapter", () => {
    const store = new AtolSettingsStore(tempFile());
    const settings = store.load();

    expect(settings.version).toBe(2);
    expect(settings.adapter).toBe("driver");
    expect(settings.enabled).toBe(false);
    expect(settings.direct).toEqual({});
  });

  it("migrates legacy Web Requests settings without losing their values", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({
      enabled: true,
      baseUrl: "http://127.0.0.1:16732/api/v2/",
      taxationType: "usnIncome",
      taxType: "vat10",
    }), "utf-8");

    const settings = new AtolSettingsStore(file).load();

    expect(settings).toMatchObject({
      version: 2,
      enabled: true,
      adapter: "web",
      taxationType: "usnIncome",
      taxType: "vat10",
      web: { baseUrl: "http://127.0.0.1:16732/api/v2" },
    });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({
      version: 2,
      adapter: "web",
    });
  });

  it("keeps the selected direct KKT while changing tax settings", () => {
    const file = tempFile();
    const store = new AtolSettingsStore(file);
    store.save({
      enabled: true,
      adapter: "driver",
      direct: {
        selectedDevice: {
          serialNumber: "1234567890",
          modelName: "ATOL",
          connection: "usb",
          settingsJson: "{\"Model\":0}",
        },
      },
    });

    const updated = store.save({ taxType: "vat22" });

    expect(updated.taxType).toBe("vat22");
    expect(updated.direct?.selectedDevice?.serialNumber).toBe("1234567890");
  });
});
