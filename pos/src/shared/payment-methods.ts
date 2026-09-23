import type { PaymentMethod, PointRules, ShiftPaymentBreakdownItem } from './contracts'

type PaymentDescriptor = {
  method:PaymentMethod
  label:string
  enabled:(rules:PointRules)=>boolean
}

// Matches the configured choices and remote-payment default in PaymentModalV2.
export const PAYMENT_METHOD_DESCRIPTORS:readonly PaymentDescriptor[]=[
  {method:'cash',label:'Наличные',enabled:(rules)=>rules.acceptsCash},
  {method:'card',label:'Карта',enabled:(rules)=>rules.acceptsCard},
  {method:'qr',label:'QR / СБП',enabled:(rules)=>rules.acceptsQr},
  {method:'remote_payment',label:'Удалённая оплата',enabled:(rules)=>rules.acceptsRemotePayment!==false},
]

export const shiftPaymentRows=(rules:PointRules,breakdown:ShiftPaymentBreakdownItem[]):Array<{method:string;label:string;amountMinor:number}>=>{
  const totals=new Map<string,number>()
  for(const {method,amountMinor} of breakdown){
    if(method&&Number.isFinite(amountMinor))totals.set(method,(totals.get(method)??0)+amountMinor)
  }
  const configured=PAYMENT_METHOD_DESCRIPTORS.filter(({method,enabled})=>enabled(rules)||Boolean(totals.get(method)))
    .map(({method,label})=>({method,label,amountMinor:totals.get(method)??0}))
  const known=new Set<string>(PAYMENT_METHOD_DESCRIPTORS.map(({method})=>method))
  const historical=[...totals].filter(([method,amountMinor])=>!known.has(method)&&amountMinor!==0)
    .sort(([left],[right])=>left.localeCompare(right))
    .map(([method,amountMinor])=>({method,label:'Другой способ оплаты ('+method.slice(0,80)+')',amountMinor}))
  return [...configured,...historical]
}
