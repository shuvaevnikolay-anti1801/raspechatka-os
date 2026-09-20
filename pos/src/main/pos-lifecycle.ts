import type { PosLifecycleStatus } from "../shared/contracts";
import type { PosDatabase } from "./database";

const LIFECYCLE_KEY = "pos_lifecycle_v1";

export class PosLifecycleStore {
  constructor(
    private readonly database: PosDatabase,
    existingInstallation: boolean
  ) {
    if (!this.read()) {
      this.write({
        state: existingInstallation ? "READY" : "NEW",
        updatedAt: new Date().toISOString(),
        legacyInstallation: existingInstallation || undefined,
      });
    }
  }

  status(): PosLifecycleStatus {
    return this.read() ?? {
      state: "NEW",
      updatedAt: new Date().toISOString(),
    };
  }

  beginConfiguration(): PosLifecycleStatus {
    const current = this.status();
    if (current.state === "READY") return current;
    return this.write({
      state: "CONFIGURING",
      updatedAt: new Date().toISOString(),
      legacyInstallation: current.legacyInstallation,
    });
  }

  markReady(): PosLifecycleStatus {
    const current = this.status();
    return this.write({
      state: "READY",
      updatedAt: new Date().toISOString(),
      legacyInstallation: current.legacyInstallation,
    });
  }

  requireReady(): void {
    if (this.status().state !== "READY") {
      throw new Error(
        "Касса ещё не настроена. Завершите первоначальное подключение к Распечатка OS."
      );
    }
  }

  private read(): PosLifecycleStatus | undefined {
    const raw = this.database.getState(LIFECYCLE_KEY);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Partial<PosLifecycleStatus>;
      if (
        (value.state === "NEW" ||
          value.state === "CONFIGURING" ||
          value.state === "READY") &&
        typeof value.updatedAt === "string"
      ) {
        return {
          state: value.state,
          updatedAt: value.updatedAt,
          legacyInstallation: Boolean(value.legacyInstallation) || undefined,
        };
      }
    } catch {
      // Invalid local state is replaced with the safe first-run state.
    }
    return undefined;
  }

  private write(value: PosLifecycleStatus): PosLifecycleStatus {
    this.database.setState(LIFECYCLE_KEY, JSON.stringify(value));
    return value;
  }
}
