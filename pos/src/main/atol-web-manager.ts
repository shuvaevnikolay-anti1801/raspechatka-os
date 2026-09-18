import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { safeStorage } from "electron";

export type AtolCredentials = { username: string; password: string };
export type AtolWebStatus = {
  ready: boolean;
  message: string;
  executable?: string;
};

export class AtolCredentialStore {
  constructor(private readonly filePath: string) {}
  load(): AtolCredentials | undefined {
    if (!existsSync(this.filePath) || !safeStorage.isEncryptionAvailable())
      return undefined;
    try {
      return JSON.parse(
        safeStorage.decryptString(readFileSync(this.filePath))
      ) as AtolCredentials;
    } catch {
      return undefined;
    }
  }
  save(value: AtolCredentials): void {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error(
        "Windows пока не предоставила защищённое хранилище для АТОЛ"
      );
    writeFileSync(
      this.filePath,
      safeStorage.encryptString(JSON.stringify(value))
    );
  }
}

export class AtolWebManager {
  private pending?: Promise<AtolWebStatus>;
  private authorizationRecovery?: Promise<void>;

  constructor(private readonly credentials: AtolCredentialStore) {}

  ensureReady(): Promise<AtolWebStatus> {
    if (!this.pending)
      this.pending = this.ensureReadyOnce().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  authorizationHeader(): string | undefined {
    const value = this.credentials.load();
    return value
      ? `Basic ${Buffer.from(`${value.username}:${value.password}`).toString(
          "base64"
        )}`
      : undefined;
  }

  async configureAtol1F(): Promise<void> {
    await this.ensureReady();
    const authorization = this.authorizationHeader();
    if (!authorization)
      throw new Error("Не найдена служебная учётная запись ATOL Web Requests");

    const deviceId = "raspechatka-atol-1f";
    const device = {
      id: deviceId,
      name: "АТОЛ 1Ф",
      isActive: true,
      isDefault: true,
      connectionSettings: {
        model: 93,
        accessPassword: "",
        userPassword: "",
        port: "usb",
        com: "",
        baudRate: 1200,
        usbDevice: "auto",
        ipAddress: "",
        ipPort: 0,
        mac: "",
        ofdChannel: "auto",
      },
      otherSettings: {
        useGlobalScriptsSettings: true,
        scriptsPath: "",
        useGlobalInvertCashDrawerStatusFlag: true,
        invertCashDrawerStatus: false,
        useGlobalAdditionalHeaderLines: true,
        additionalHeaderLines: "",
        useGlobalAdditionalFooterLines: true,
        additionalFooterLines: "",
      },
    };
    const headers = {
      Authorization: authorization,
      "Content-Type": "application/json",
    };
    const create = await fetch("http://127.0.0.1:16732/api/v2/devices", {
      method: "POST",
      headers,
      body: JSON.stringify(device),
      signal: AbortSignal.timeout(5000),
    });
    if (create.status === 409) {
      const update = await fetch(
        `http://127.0.0.1:16732/api/v2/devices/${encodeURIComponent(deviceId)}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            name: device.name,
            connectionSettings: device.connectionSettings,
            otherSettings: device.otherSettings,
          }),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!update.ok) throw await this.responseError(update, "обновить АТОЛ 1Ф");
    } else if (!create.ok) {
      throw await this.responseError(create, "добавить АТОЛ 1Ф");
    }

    const activate = await fetch(
      `http://127.0.0.1:16732/api/v2/activateDevice?deviceID=${encodeURIComponent(deviceId)}`,
      {
        method: "POST",
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!activate.ok) throw await this.responseError(activate, "активировать АТОЛ 1Ф");
  }

  recoverAuthorization(): Promise<void> {
    if (!this.authorizationRecovery)
      this.authorizationRecovery = this.recoverAuthorizationOnce().finally(() => {
        this.authorizationRecovery = undefined;
      });
    return this.authorizationRecovery;
  }

  private async ensureReadyOnce(): Promise<AtolWebStatus> {
    const webExecutable = this.find("atol-fptr-web-requests.exe");
    const startScript = this.find("start-web-requests.bat");
    const usersExecutable = this.find("atol-fptr-web-requests-users.exe");
    if (!(await this.reachable())) {
      const launcher = startScript ?? webExecutable;
      if (!launcher)
        throw new Error(
          "ATOL Web Server не найден. Установите компонент Web Requests драйвера АТОЛ 10."
        );
      const child = spawn(launcher, [], {
        cwd: dirname(launcher),
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        shell: launcher.endsWith(".bat"),
      });
      child.unref();
      for (
        let attempt = 0;
        attempt < 20 && !(await this.reachable());
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 500));
      if (!(await this.reachable()))
        throw new Error(
          "ATOL Web Server найден, но не запустился на 127.0.0.1:16732"
        );
    }
    if (!this.credentials.load()) {
      if (!usersExecutable)
        throw new Error(
          "Не найдена утилита создания пользователя ATOL Web Server"
        );
      this.provisionCredentials(usersExecutable);
    }
    return {
      ready: true,
      message: "ATOL Web Server подключён",
      executable: webExecutable,
    };
  }

  private async recoverAuthorizationOnce(): Promise<void> {
    await this.ensureReady();
    const usersExecutable = this.find("atol-fptr-web-requests-users.exe");
    if (!usersExecutable)
      throw new Error(
        "Не найдена утилита восстановления пользователя ATOL Web Server"
      );
    this.provisionCredentials(usersExecutable);
  }

  private provisionCredentials(usersExecutable: string): void {
    const value = {
      username: "raspechatka",
      password: `Rp${randomBytes(16).toString("base64url")}9a`,
    };
    const listed = spawnSync(usersExecutable, ["list"], {
      cwd: dirname(usersExecutable),
      windowsHide: true,
      encoding: "utf8",
    });
    if (listed.status !== 0)
      throw new Error("Не удалось проверить пользователей ATOL Web Server");
    if (
      new RegExp(`(^|\\s)${value.username}(\\s|$)`, "mi").test(
        `${listed.stdout}\n${listed.stderr}`
      )
    ) {
      const removed = spawnSync(usersExecutable, ["del", value.username], {
        cwd: dirname(usersExecutable),
        windowsHide: true,
        encoding: "utf8",
      });
      if (removed.status !== 0)
        throw new Error(
          "Не удалось обновить служебную учётную запись ATOL Web Server"
        );
    }
    const result = spawnSync(
      usersExecutable,
      ["add", value.username, value.password],
      { cwd: dirname(usersExecutable), windowsHide: true, encoding: "utf8" }
    );
    if (result.status !== 0)
      throw new Error(
        `Не удалось создать пользователя ATOL Web Server${
          result.stderr ? `: ${result.stderr.trim()}` : ""
        }`
      );
    this.credentials.save(value);
  }

  private async responseError(response: Response, action: string): Promise<Error> {
    const text = await response.text();
    return new Error(
      `Не удалось ${action}: HTTP ${response.status}${text ? ` · ${text.slice(0, 250)}` : ""}`
    );
  }

  private async reachable(): Promise<boolean> {
    try {
      const response = await fetch("http://127.0.0.1:16732", {
        signal: AbortSignal.timeout(1200),
      });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  private find(file: string): string | undefined {
    const roots = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ].filter(Boolean) as string[];
    return roots
      .map((root) => join(root, "ATOL", "Drivers10", "KKT", "web", file))
      .find(existsSync);
  }
}
