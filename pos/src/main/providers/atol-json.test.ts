import { formatPersonShortName } from "../../shared/person-name";
import { describe, expect, it } from "vitest";
import { allocateFiscalAmounts, buildAtolReceiptJson, buildAtolShiftJson } from "./atol-json";

describe("ATOL JSON builder", () => {
  it("allocates fractional and many-line fiscal amounts exactly",()=>{
    const lines=Array.from({length:17},(_,index)=>({
      productId:String(index),name:'Позиция',quantity: index%3===0?0.333:1,unitPriceMinor: index%2?101:199,
    }))
    const allocated=allocateFiscalAmounts(lines,1234)
    expect(allocated.every((value)=>value>=0)).toBe(true)
    expect(allocated.reduce((sum,value)=>sum+value,0)).toBe(1234)
  })

  it.each([1, 37, 99])("matches persisted payable and historical return allocation at %i kopecks", (adjustment) => {
    const lines = Array.from({length: 19}, (_, index) => ({
      productId: String(index), name: "Услуга", quantity: index % 2 ? 0.333 : 1,
      unitPriceMinor: 101 + index, itemType: "service",
    }));
    const rawTotal = lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitPriceMinor), 0);
    const payable = rawTotal - adjustment;
    const payments = [
      {method: "cash" as const, amountMinor: 50},
      {method: "card" as const, amountMinor: payable - 50},
    ];
    const sale = buildAtolReceiptJson({
      type: "sell", amountMinor: payable, payments, lines,
      taxationType: "patent", taxType: "none",
    });
    const items = sale.items as Array<{amount: number; paymentObject: string}>;
    expect(Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100)).toBe(payable);
    expect(items.every((item) => item.paymentObject === "service")).toBe(true);
    const historical = lines.map((line, index) => ({
      ...line, lineTotalMinor: Math.round(items[index].amount * 100),
    }));
    const returned = buildAtolReceiptJson({
      type: "sellReturn", amountMinor: payable, payments, lines: historical,
      taxationType: "patent", taxType: "none",
    });
    expect((returned.items as Array<{amount: number}>).map((item) => item.amount))
      .toEqual(items.map((item) => item.amount));
    expect(() => allocateFiscalAmounts(historical, payable + 1)).toThrow(/сохранённые суммы/i);
  });

  it("keeps discounted total and builds a sell receipt with operator", () => {
    expect(allocateFiscalAmounts([
      { productId: "a", name: "A", quantity: 1, unitPriceMinor: 100, discountPercent: 0 },
      { productId: "b", name: "B", quantity: 1, unitPriceMinor: 100, discountPercent: 0 },
      { productId: "c", name: "C", quantity: 1, unitPriceMinor: 100, discountPercent: 0 },
    ], 100)).toEqual([33, 34, 33]);

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
      const wire = Buffer.from(JSON.stringify({ protocolVersion: 1, id: "1", command: "executeJson", args: { json: JSON.stringify(command) } }) + "\n", "utf8");
      const parsed = JSON.parse(wire.toString("utf8").trim());
      expect(JSON.parse(parsed.args.json).operator).toEqual({ name: "Иванова А. С." });
    }
  });
});
