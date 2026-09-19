import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type AtolDirectDevice = {
  serialNumber: string;
  modelName: string;
  connection: "usb" | "com" | "tcp";
  settingsJson: string;
};

export type AtolWebSettings = {
  baseUrl: string;
};

export type AtolSettings = {
  version: 2;
  enabled: boolean;
  adapter: "driver" | "web";
  taxationType: string;
  taxType: string;
  direct?: { selectedDevice?: AtolDirectDevice };
  web: AtolWebSettings;
};

const DEFAULT_SETTINGS: AtolSettings = {
  version: 2,
  enabled: false,
  adapter: "driver",
  taxationType: "patent",
  taxType: "none",
  direct: {},
  web: { baseUrl: "http://127.0.0.1:16732/api/v2" },
};

type LegacyAtolSettings = {
  version?: number;
  adapter?: "driver" | "web";
  enabled?: boolean;
  baseUrl?: string;
  taxationType?: string;
  taxType?: string;
};

export class AtolSettingsStore {
  constructor(private readonly filePath: string) {}

  load(): AtolSettings {
    if (!existsSync(this.filePath)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as
        | AtolSettings
        | LegacyAtolSettings;
      if (raw.version === 2 && (raw.adapter === "driver" || raw.adapter === "web")) {
        return this.normalize(raw as AtolSettings);
      }
      return this.migrateLegacy(raw);
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  save(value: Partial<AtolSettings>): AtolSettings {
    const current = this.load();
    const next = this.normalize({
      ...current,
      ...value,
      direct: { ...current.direct, ...value.direct },
      web: { ...current.web, ...value.web },
      version: 2,
    });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf-8");
    return next;
  }

  private migrateLegacy(value: LegacyAtolSettings): AtolSettings {
    const next = this.normalize({
      ...DEFAULT_SETTINGS,
      enabled: value.enabled ?? DEFAULT_SETTINGS.enabled,
      adapter: "web",
      taxationType: value.taxationType ?? DEFAULT_SETTINGS.taxationType,
      taxType: value.taxType ?? DEFAULT_SETTINGS.taxType,
      web: { baseUrl: value.baseUrl ?? DEFAULT_SETTINGS.web.baseUrl },
    });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf-8");
    return next;
  }

  private normalize(value: AtolSettings): AtolSettings {
    const baseUrl = value.web?.baseUrl?.trim().replace(/\/$/, "") ||
      DEFAULT_SETTINGS.web.baseUrl;
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Адрес ATOL Web Server должен начинаться с http:// или https://");

    return {
      version: 2,
      enabled: Boolean(value.enabled),
      adapter: value.adapter === "web" ? "web" : "driver",
      taxationType: value.taxationType || DEFAULT_SETTINGS.taxationType,
      taxType: value.taxType || DEFAULT_SETTINGS.taxType,
      direct: value.direct?.selectedDevice
        ? { selectedDevice: value.direct.selectedDevice }
        : {},
      web: { baseUrl },
    };
  }
}
