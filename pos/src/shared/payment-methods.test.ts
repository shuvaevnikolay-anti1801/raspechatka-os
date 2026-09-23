import { describe, expect, it } from 'vitest'
import type { PointRules } from './contracts'
import { shiftPaymentRows } from './payment-methods'

const rules:PointRules={
  allowFreePrice:false,allowRemoveCartItem:true,allowDiscounts:true,maxDiscountPercent:100,
  acceptsCash:true,acceptsCard:true,acceptsQr:true,
}

describe('shift payment rows',()=>{
  it('shows configured cash, card, QR and remote methods in the payment modal order',()=>{
    expect(shiftPaymentRows(rules,[]).map(({method})=>method))
      .toEqual(['cash','card','qr','remote_payment'])
    expect(shiftPaymentRows({...rules,acceptsRemotePayment:false},[]).map(({method})=>method))
      .toEqual(['cash','card','qr'])
  })

  it('retains historical amounts after a method is disabled',()=>{
    const rows=shiftPaymentRows({...rules,acceptsCard:false,acceptsQr:false,acceptsRemotePayment:false},[
      {method:'card',amountMinor:2400},{method:'qr',amountMinor:500},{method:'remote_payment',amountMinor:1000},
    ])
    expect(rows).toEqual([
      {method:'cash',label:'Наличные',amountMinor:0},
      {method:'card',label:'Карта',amountMinor:2400},
      {method:'qr',label:'QR / СБП',amountMinor:500},
      {method:'remote_payment',label:'Удалённая оплата',amountMinor:1000},
    ])
  })

  it('renders unknown historical methods with a bounded, safe fallback label',()=>{
    const legacy='<legacy-method>'
    const rows=shiftPaymentRows({...rules,acceptsCash:false,acceptsCard:false,acceptsQr:false,acceptsRemotePayment:false},[
      {method:legacy,amountMinor:500},{method:legacy,amountMinor:250},
    ])
    expect(rows).toEqual([{method:legacy,label:'Другой способ оплаты (<legacy-method>)',amountMinor:750}])
    expect(shiftPaymentRows({...rules,acceptsCash:false,acceptsCard:false,acceptsQr:false,acceptsRemotePayment:false},[
      {method:'unused',amountMinor:0},
    ])).toEqual([])
  })
})
