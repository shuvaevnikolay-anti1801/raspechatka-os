import type { CartLine } from './contracts'

export function calculateSubtotalMinor(lines: CartLine[]): number {
  return lines.reduce((total, line) => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error('Количество должно быть больше нуля')
    if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) throw new Error('Цена должна храниться целым числом копеек')
    const discount = Math.min(Math.max(line.discountPercent ?? 0, 0), 100)
    return total + Math.round(line.quantity * line.unitPriceMinor * (1 - discount / 100))
  }, 0)
}

export function calculateTotalMinor(lines: CartLine[], receiptDiscountPercent = 0): number {
  const discount = Math.min(Math.max(receiptDiscountPercent, 0), 100)
  return Math.round(calculateSubtotalMinor(lines) * (1 - discount / 100))
}
