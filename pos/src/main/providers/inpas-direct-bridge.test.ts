import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  NativeInpasBridge,
  resolveInpasBridgeExecutablePath,
  type InpasOriginalOperationRequest,
} from "./inpas-direct-bridge";

function fakeProcess(requests: Array<Record<string, unknown>>): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => {
      Object.assign(child, { killed: true, exitCode: 0 });
      child.emit("exit", 0, null);
      return true;
    },
  });
  stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk).trim()) as {
      protocolVersion: number;
      id: string;
      command: string;
      args?: Record<string, unknown>;
    };
    requests.push(request);
    stdout.write(JSON.stringify({
      protocolVersion: 1,
      id: request.id,
      ok: true,
      result: request.command === "shutdown"
        ? { stopping: true }
        : {
            success: true,
            outcome: "approved",
            status: "approved",
            operationKind: request.command,
            terminalId: request.args?.terminalId,
            referenceNumber: "REFUND-REF",
            responseCode: "00",
          },
      error: null,
    }) + "\n");
    if (request.command === "shutdown") {
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, null);
    }
  });
  return child;
}

function crashingProcess(requests: Array<Record<string, unknown>>): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => true,
  });
  stdin.on("data", (chunk) => {
    requests.push(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
    Object.assign(child, { exitCode: 1 });
    child.emit("exit", 1, null);
  });
  return child;
}

describe("NativeInpasBridge refund protocol", () => {
  it("sends refund and void as separate commands with original evidence", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const bridge = new NativeInpasBridge({
      executablePath: "Raspechatka.InpasBridge.exe",
      spawnProcess: () => fakeProcess(requests),
    });
    const original: InpasOriginalOperationRequest = {
      terminalId: "40000037",
      amountMinor: 500,
      currency: "643",
      method: "card",
      referenceNumber: "RRN-ORIGINAL",
      terminalTransactionId: "TRX-ORIGINAL",
      authorizationCode: "AUTH-1",
    };

    await bridge.refund(original);
    await bridge.voidPayment(original);

    expect(requests.map((request) => request.command)).toEqual(["refund", "void"]);
    expect(requests[0].args).toMatchObject({
      terminalId: "40000037",
      amountMinor: 500,
      referenceNumber: "RRN-ORIGINAL",
    });
    expect(requests[1].args).toMatchObject({
      terminalId: "40000037",
      referenceNumber: "RRN-ORIGINAL",
    });
  });

  it("rejects missing original reference without starting the helper", async () => {
    let spawnCalls = 0;
    const bridge = new NativeInpasBridge({
      executablePath: "Raspechatka.InpasBridge.exe",
      spawnProcess: () => {
        spawnCalls += 1;
        return fakeProcess([]);
      },
    });

    expect(() => bridge.refund({
      terminalId: "40000037",
      amountMinor: 500,
      currency: "643",
      method: "card",
      referenceNumber: "",
    })).toThrow(/ReferenceNumber/);
    expect(spawnCalls).toBe(0);
  });
  it("restarts only the helper after a dangerous command crashes", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let spawnCalls = 0;
    const bridge = new NativeInpasBridge({
      executablePath: "Raspechatka.InpasBridge.exe",
      spawnProcess: () => {
        spawnCalls += 1;
        return spawnCalls === 1
          ? crashingProcess(requests)
          : fakeProcess(requests);
      },
    });

    await expect(bridge.sale({
      terminalId: "40000037",
      amountMinor: 500,
      currency: "643",
      method: "card",
    })).rejects.toThrow(/exited/);

    const status = await bridge.getStatus();
    expect(status.status).toBe("approved");
    expect(spawnCalls).toBe(2);
    expect(requests.map((request) => request.command)).toEqual(["sale", "status"]);
    expect(requests.filter((request) => request.command === "sale")).toHaveLength(1);
  });

  it("resolves packaged and development helper paths deterministically", () => {
    const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
    const previousResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    const previousEnv = process.env.RASPECHATKA_INPAS_BRIDGE_PATH;
    try {
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        value: "C:\\Program Files\\Raspechatka\\resources",
      });
      expect(resolveInpasBridgeExecutablePath({ isPackaged: true })).toBe(join(
        "C:\\Program Files\\Raspechatka\\resources",
        "native",
        "inpas",
        "Raspechatka.InpasBridge.exe"
      ));
      process.env.RASPECHATKA_INPAS_BRIDGE_PATH = "D:\\tools\\InpasBridge.exe";
      expect(resolveInpasBridgeExecutablePath({ isPackaged: false }))
        .toBe("D:\\tools\\InpasBridge.exe");
    } finally {
      if (previousResources) Object.defineProperty(process, "resourcesPath", previousResources);
      else Reflect.deleteProperty(electronProcess, "resourcesPath");
      if (previousEnv === undefined) delete process.env.RASPECHATKA_INPAS_BRIDGE_PATH;
      else process.env.RASPECHATKA_INPAS_BRIDGE_PATH = previousEnv;
    }
  });

  it("reports a missing helper as not_configured before spawn", async () => {
    const bridge = new NativeInpasBridge({
      executablePath: join(process.cwd(), "missing-inpas-bridge", "Raspechatka.InpasBridge.exe"),
    });
    await expect(bridge.getDriverInfo()).rejects.toMatchObject({
      code: "not_configured",
    });
  });

});
