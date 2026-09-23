import { formatPersonShortName } from "../../shared/person-name";
import { describe, expect, it } from "vitest";
import { allocateFiscalAmounts, buildAtolReceiptJson, buildAtolShiftJson } from "./atol-json";

describe("ATOL JSON builder", () => {
  it("keeps discounted total and builds a sell receipt with operator", () => {
    expect(allocateFiscalAmounts([
      { productId: "a", name: "A", quantity: 1, unitPriceMinor: 100, discountPercent: 0 },
      { productId: "b", name: "B", quantity: 1, unitPriceMinor: 100, discountPercent: 0 },
      { productId: "c", name: "C", quantity: 1, unitPriceMinor: 100, discountPercent: 0 },
    ], 100)).toEqual([33, 33, 34]);

    const json = buildAtolReceiptJson({
      type: "sell",
      amountMinor: 10000,
      payments: [{ method: "cash", amountMinor: 10000 }],
      lines: [{ productId: "a", name: "Услуга", quantity: 1, unitPriceMinor: 10000, discountPercent: 0 }],
      taxationType: "patent",
      taxType: "none",
      operatorName: "Анна",
    });

    expect(json).toMatchObject({
      type: "sell",
      taxationType: "patent",
      payments: [{ type: "cash", sum: 100 }],
      operator: { name: "Анна" },
    });
    expect(json.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ paymentObject: "commodity", paymentMethod: "fullPayment" }),
    ]));
  });
  it("preserves Cyrillic operator through shift and sale/return JSONL UTF-8", () => {
    const operatorName = formatPersonShortName("  Иванова   Анна  Сергеевна ");
    const receipt = (type: "sell" | "sellReturn") => buildAtolReceiptJson({
      type, amountMinor: 100, payments: [{ method: "cash", amountMinor: 100 }],
      lines: [{ productId: "a", name: "Печать", quantity: 1, unitPriceMinor: 100 }],
      taxationType: "patent", taxType: "none", operatorName,
    });
    for (const command of [
      buildAtolShiftJson("openShift", operatorName),
      buildAtolShiftJson("closeShift", operatorName),
      receipt("sell"),
      receipt("sellReturn"),
    ]) {
      const wire = Buffer.from(JSON.stringify({ protocolVersion: 1, id: "1", command: "executeJson", args: { json: JSON.stringify(command) } }) + "\\n", "utf8");
      const parsed = JSON.parse(wire.toString("utf8").trim());
      expect(JSON.parse(parsed.args.json).operator).toEqual({ name: "Иванова А. С." });
    }
  });
});
