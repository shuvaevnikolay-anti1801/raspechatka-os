import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  NativeInpasBridge,
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
});
