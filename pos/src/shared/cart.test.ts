import { describe, expect, it } from 'vitest'
import { calculateTotalMinor } from './cart'

describe('calculateTotalMinor', () => {
  it('sums prices in minor currency units', () => {
    expect(
      calculateTotalMinor([
        { productId: 'a', name: 'A', quantity: 2, unitPriceMinor: 2000 },
        { productId: 'b', name: 'B', quantity: 1, unitPriceMinor: 5000 }
      ])
    ).toBe(9000)
  })

  it('rejects invalid quantity', () => {
    expect(() =>
      calculateTotalMinor([{ productId: 'a', name: 'A', quantity: 0, unitPriceMinor: 100 }])
    ).toThrow()
  })
})
