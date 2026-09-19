import { describe, expect, it } from "vitest";
import { allocateFiscalAmounts, buildAtolReceiptJson } from "./atol-json";

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
      lines: [{ productId: "a", name: "Услуга", quantity: 1, unitPriceMinor: 10000, discountPercent: 0, itemType: "service" }],
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
      expect.objectContaining({ paymentObject: "service", paymentMethod: "fullPayment" }),
    ]));
  });
});
