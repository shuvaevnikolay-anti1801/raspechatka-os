import { useEffect, useState } from 'react'
import type { CompleteSaleResult, PaymentPart } from '../../shared/contracts'
import './pilot-ux.css'

const money=(minor:number)=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(minor/100)
const paymentName=(method:string)=>({cash:'Наличные',card:'Карта',qr:'QR / СБП',remote_payment:'Удалённая оплата'}[method]||method)
type Payload={result:CompleteSaleResult;payments:PaymentPart[]}

export default function SaleSuccessOverlay(){
  const [payload,setPayload]=useState<Payload|null>(null)
  useEffect(()=>{
    const handler=(event:MessageEvent)=>{
      if(event.source!==window)return
      const data=event.data as {source?:string;type?:string;result?:CompleteSaleResult;payments?:PaymentPart[]}
      if(data?.source==='raspechatka-pos'&&data.type==='sale-completed'&&data.result){
        setPayload({result:data.result,payments:data.payments||[]})
      }
    }
    window.addEventListener('message',handler)
    return()=>window.removeEventListener('message',handler)
  },[])
  if(!payload)return null
  const {result,payments}=payload
  return <div className="sale-success-backdrop">
    <section className="sale-success-card">
      <div className="sale-success-icon">✓</div>
      <small>ПРОДАЖА ЗАВЕРШЕНА</small>
      <h2>{result.order?`Заказ ${result.order.orderNumber}`:`Чек ${result.receiptNumber}`}</h2>
      <strong className="sale-success-total">{money(result.totalMinor)}</strong>
      <div className="sale-success-grid">
        <div><span>Оплата</span><b>{payments.map((p)=>paymentName(p.method)).join(' + ')||'—'}</b></div>
        <div><span>Сдача</span><b className={result.changeMinor?'change':''}>{result.changeMinor?money(result.changeMinor):'Без сдачи'}</b></div>
        <div><span>Фискальный чек</span><b>Сформирован</b></div>
        <div><span>Товарный чек</span><b className={result.commodityPrintWarning?'warning':''}>{result.commodityPrintWarning?'Нужна повторная печать':'Напечатан'}</b></div>
      </div>
      {result.changeMinor>0&&<div className="change-callout"><span>Сдача клиенту</span><strong>{money(result.changeMinor)}</strong></div>}
      {result.commodityPrintWarning&&<div className="pilot-message warning">Продажа уже завершена. Товарный чек можно повторно напечатать через «Оборудование».</div>}
      <button autoFocus className="primary new-sale-button" onClick={()=>setPayload(null)}>Новая продажа</button>
      <small className="hotkey-hint">Enter — новая продажа</small>
    </section>
  </div>
}
