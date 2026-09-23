import type { CartLine, PaymentPart } from "../../shared/contracts";

export type AtolReceiptType = "sell" | "sellReturn";

export type BuildAtolReceiptOptions = {
  type: AtolReceiptType;
  amountMinor: number;
  payments: PaymentPart[];
  lines: CartLine[];
  taxationType: string;
  taxType: string;
  operatorName?: string;
};

export function allocateFiscalAmounts(
  lines: CartLine[],
  totalMinor: number
): number[] {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0)
    throw new Error("Некорректная сумма фискального чека");
  if (!lines.length) {
    if (totalMinor !== 0) throw new Error("В чеке отсутствуют фискальные позиции");
    return [];
  }
  const persisted = lines.map((line) => (line as CartLine & { lineTotalMinor?: number }).lineTotalMinor);
  if (persisted.some((value) => value !== undefined)) {
    if (persisted.some((value) => !Number.isSafeInteger(value) || value! < 0) ||
        persisted.reduce<number>((sum, value) => sum + (value ?? 0), 0) !== totalMinor)
      throw new Error("Сохранённые суммы позиций не совпадают с фискальным итогом");
    return persisted as number[];
  }
  const raw = lines.map((line) =>
    Math.max(
      0,
      Math.round(
        line.quantity *
          line.unitPriceMinor *
          (1 - (line.discountPercent ?? 0) / 100)
      )
    )
  );
  const rawTotal = raw.reduce((sum, value) => sum + value, 0);
  if (rawTotal <= 0)
    throw new Error("Сумма фискальных позиций должна быть больше нуля");

  // Cumulative allocation avoids a negative final line on many small items.
  let cumulativeRaw = 0;
  let allocated = 0;
  const result = raw.map((value, index) => {
    cumulativeRaw += value;
    const target = index === raw.length - 1
      ? totalMinor
      : Math.round((totalMinor * cumulativeRaw) / rawTotal);
    const amount = target - allocated;
    allocated = target;
    return amount;
  });
  if (
    result.some((amount) => amount < 0) ||
    result.reduce((sum, value) => sum + value, 0) !== totalMinor
  ) {
    throw new Error(
      "Не удалось распределить итоговую сумму по позициям фискального чека"
    );
  }
  return result;
}

export function buildAtolReceiptJson(
  options: BuildAtolReceiptOptions
): Record<string, unknown> {
  const paymentTotal = options.payments.reduce(
    (sum, payment) => sum + payment.amountMinor,
    0
  );
  if (!Number.isSafeInteger(options.amountMinor) || options.amountMinor <= 0 ||
      options.payments.some((payment) => !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor < 0) ||
      paymentTotal !== options.amountMinor)
    throw new Error("Сумма оплат не совпадает с итогом фискального чека");

  const payments = new Map<"cash" | "electronically", number>();
  for (const payment of options.payments) {
    const type = payment.method === "cash" ? "cash" : "electronically";
    payments.set(type, (payments.get(type) ?? 0) + payment.amountMinor);
  }

  const body: Record<string, unknown> = {
    type: options.type,
    taxationType: options.taxationType,
    electronically: false,
    ignoreNonFiscalPrintErrors: false,
    payments: [...payments.entries()].map(([type, amount]) => ({
      type,
      sum: amount / 100,
    })),
    total: options.amountMinor / 100,
  };
  if (options.lines.length) {
    const allocated = allocateFiscalAmounts(options.lines, options.amountMinor);
    body.items = options.lines.map((line, index) => {
      const amountMinor = allocated[index];
      return {
        type: "position",
        name: line.name,
        price: (line.quantity > 0 ? amountMinor / line.quantity : 0) / 100,
        quantity: line.quantity,
        amount: amountMinor / 100,
        paymentObject:
          (line as CartLine & { itemType?: string }).itemType === "service"
            ? "service"
            : "commodity",
        paymentMethod: "fullPayment",
        tax: { type: options.taxType },
      };
    });
  }
  if (options.operatorName?.trim()) {
    body.operator = { name: options.operatorName.trim() };
  }
  return body;
}

export function buildAtolShiftJson(
  type: "openShift" | "closeShift",
  operatorName?: string
): Record<string, unknown> {
  const request: Record<string, unknown> = { type, electronically: false };
  if (operatorName?.trim()) request.operator = { name: operatorName.trim() };
  return request;
}

export function pickAtolString(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim())
      return String(value);
  }
  return undefined;
}
