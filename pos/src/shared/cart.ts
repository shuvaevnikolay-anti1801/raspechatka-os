import type { CartLine } from './contracts'

export function calculateTotalMinor(lines: CartLine[]): number {
  return lines.reduce((total, line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error('Количество товара должно быть положительным целым числом')
    }
    if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
      throw new Error('Цена должна храниться целым числом копеек')
    }
    return total + line.quantity * line.unitPriceMinor
  }, 0)
}
