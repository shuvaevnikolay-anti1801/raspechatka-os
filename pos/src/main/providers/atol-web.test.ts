import { describe, expect, it } from 'vitest'
import { allocateFiscalAmounts } from './atol-web'

describe('allocateFiscalAmounts',()=>{
  it('keeps fiscal positions equal to discounted receipt total',()=>{
    const amounts=allocateFiscalAmounts([
      {productId:'a',name:'A',quantity:1,unitPriceMinor:10000,discountPercent:0},
      {productId:'b',name:'B',quantity:2,unitPriceMinor:5000,discountPercent:0}
    ],18000)
    expect(amounts.reduce((sum,value)=>sum+value,0)).toBe(18000)
    expect(amounts).toEqual([9000,9000])
  })

  it('absorbs rounding into the last position without changing receipt total',()=>{
    const amounts=allocateFiscalAmounts([
      {productId:'a',name:'A',quantity:1,unitPriceMinor:100,discountPercent:0},
      {productId:'b',name:'B',quantity:1,unitPriceMinor:100,discountPercent:0},
      {productId:'c',name:'C',quantity:1,unitPriceMinor:100,discountPercent:0}
    ],100)
    expect(amounts).toEqual([33,33,34])
    expect(amounts.reduce((sum,value)=>sum+value,0)).toBe(100)
  })
})
