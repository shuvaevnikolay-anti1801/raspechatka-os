import { describe, expect, it } from 'vitest'
import { findUpsellRuleForProduct, resolveUpsellAfterCart, selectUpsellCandidate } from './upsell'
import type { CartLine, Product, UpsellRule } from './contracts'

const product=(id:string, extra:Partial<Product>={}):Product=>({
  id,name:id,sku:id,category:'test',type:'product',uom:'шт',priceMinor:100,...extra,
})

const rule:UpsellRule={
  triggerItem:'trigger',
  enabled:true,
  candidates:[{item:'a',cashierPhrase:'A'},{item:'b',cashierPhrase:'B'},{item:'c',cashierPhrase:'C'}],
}

describe('findUpsellRuleForProduct',()=>{
  it('uses the rule for the product just added instead of an older trigger already in cart',()=>{
    const other={...rule,triggerItem:'older'}
    expect(findUpsellRuleForProduct([other,rule],'trigger')).toBe(rule)
    expect(findUpsellRuleForProduct([other,rule],'missing')).toBeUndefined()
  })
})

describe('selectUpsellCandidate',()=>{
  it('rotates deterministically and wraps around',()=>{
    const products=['a','b','c'].map((id)=>product(id))
    expect(selectUpsellCandidate(rule,products,[],0)).toEqual({candidate:rule.candidates[0],nextCursor:1})
    expect(selectUpsellCandidate(rule,products,[],2)).toEqual({candidate:rule.candidates[2],nextCursor:0})
  })
  it('skips cart items and unavailable stock',()=>{
    const products=[
      product('a',{trackInventory:true,stock:0,allowNegativeStock:false}),
      product('b'),
      product('c'),
    ]
    const cart:CartLine[]=[{productId:'b',name:'b',quantity:1,unitPriceMinor:100}]
    expect(selectUpsellCandidate(rule,products,cart,0)).toEqual({candidate:rule.candidates[2],nextCursor:0})
  })
  it('returns no candidate when every target is ineligible',()=>{
    const products=[product('a'),product('b')]
    const cart:CartLine[]=[
      {productId:'a',name:'a',quantity:1,unitPriceMinor:100},
      {productId:'b',name:'b',quantity:1,unitPriceMinor:100},
    ]
    expect(selectUpsellCandidate({...rule,candidates:rule.candidates.slice(0,2)},products,cart,0))
      .toEqual({candidate:null,nextCursor:0})
  })
})


describe('upsell receipt cycle',()=>{
  it('resolves when its trigger is removed and never retargets itself',()=>{
    const showing={state:'showing' as const,triggerItem:'trigger',candidate:rule.candidates[0]}
    const cart=[{productId:'trigger',name:'trigger',quantity:1,unitPriceMinor:100}]
    expect(resolveUpsellAfterCart(showing,cart)).toBe(showing)
    expect(resolveUpsellAfterCart(showing,[])).toEqual({state:'resolved'})
  })
})
