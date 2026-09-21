import { describe, expect, it } from 'vitest'
import { calculateDiscountBreakdown, calculateTotalMinor } from './cart'

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

describe('calculateDiscountBreakdown',()=>{
  const rules={allowDiscounts:true,maxDiscountPercent:30,reviewDiscountPerReviewMinor:500}
  const lines=[{productId:'a',name:'A',quantity:1,unitPriceMinor:10000}]

  it('applies club, fixed review and manual discounts in the canonical order',()=>{
    expect(calculateDiscountBreakdown(lines,rules,10,2,{type:'percent',value:10})).toMatchObject({
      clubDiscountMinor:1000,reviewDiscountMinor:1000,manualDiscountMinor:800,totalDiscountMinor:2800,totalMinor:7200,
    })
  })

  it('recalculates canonical amounts after customer changes without changing review/manual input',()=>{
    const reviewCount=1
    const manualDiscount={type:'amount' as const,value:1000}
    expect(calculateDiscountBreakdown(lines,rules,10,reviewCount,manualDiscount)).toMatchObject({
      reviewCount:1,clubDiscountMinor:1000,reviewDiscountMinor:500,manualDiscountMinor:1000,totalMinor:7500,
    })
    expect(calculateDiscountBreakdown(lines,rules,20,reviewCount,manualDiscount)).toMatchObject({
      reviewCount:1,clubDiscountMinor:2000,reviewDiscountMinor:500,manualDiscountMinor:500,totalMinor:7000,
    })
    expect(calculateDiscountBreakdown(lines,rules,0,reviewCount,manualDiscount)).toMatchObject({
      reviewCount:1,clubDiscountMinor:0,reviewDiscountMinor:500,manualDiscountMinor:1000,totalMinor:8500,
    })
    expect(reviewCount).toBe(1)
    expect(manualDiscount).toEqual({type:'amount',value:1000})
  })

  it('caps the combined discount and keeps a fiscal amount of one kopeck',()=>{
    expect(calculateDiscountBreakdown(lines,{...rules,maxDiscountPercent:100},80,10,{type:'amount',value:50000})).toMatchObject({
      totalDiscountMinor:9999,totalMinor:1,
    })
  })

  it('preserves the existing whole-check block for a protected position',()=>{
    const result=calculateDiscountBreakdown([
      ...lines,{productId:'b',name:'B',quantity:1,unitPriceMinor:5000,preventDiscounts:true},
    ],rules,10,0)
    expect(result).toMatchObject({discountableSubtotalMinor:0,clubDiscountMinor:0,totalMinor:15000})
  })

  it('disables every receipt discount when the rule is off',()=>{
    expect(calculateDiscountBreakdown(lines,{...rules,allowDiscounts:false},10,2,{type:'amount',value:1000})).toMatchObject({
      totalDiscountMinor:0,totalMinor:10000,
    })
  })
})
