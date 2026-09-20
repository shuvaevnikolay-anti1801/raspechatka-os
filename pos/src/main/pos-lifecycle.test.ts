import { describe, expect, it } from "vitest";
import { PosLifecycleStore } from "./pos-lifecycle";

const database = () => {
  const values = new Map<string, string>();
  return {
    getState: (key: string) => values.get(key),
    setState: (key: string, value: string) => values.set(key, value),
  };
};

describe("PosLifecycleStore", () => {
  it("keeps a new installation blocked until initial configuration completes", () => {
    const db = database();
    const lifecycle = new PosLifecycleStore(db as never, false);

    expect(lifecycle.status().state).toBe("NEW");
    expect(() => lifecycle.requireReady()).toThrow(/ещё не настроена/);
    expect(lifecycle.beginConfiguration().state).toBe("CONFIGURING");
    expect(lifecycle.markReady().state).toBe("READY");
    expect(() => lifecycle.requireReady()).not.toThrow();
  });

  it("persists lifecycle state and upgrades an existing installation as ready", () => {
    const db = database();
    const migrated = new PosLifecycleStore(db as never, true);
    expect(migrated.status()).toMatchObject({
      state: "READY",
      legacyInstallation: true,
    });

    const restored = new PosLifecycleStore(db as never, false);
    expect(restored.status()).toMatchObject({
      state: "READY",
      legacyInstallation: true,
    });
  });
});
