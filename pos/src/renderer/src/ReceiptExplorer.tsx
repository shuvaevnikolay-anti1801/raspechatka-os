import { useMemo, useState } from 'react'
import type { SaleDetails, SaleSummary } from '../../shared/contracts'
import './pilot-ux.css'

const money=(minor:number)=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(minor/100)
const paymentName=(method:string)=>({cash:'Наличные',card:'Карта',qr:'QR / СБП',remote_payment:'Удалённая оплата',mixed:'Смешанная'}[method]||method)

export default function ReceiptExplorer(){
  const [open,setOpen]=useState(false)
  const [sales,setSales]=useState<SaleSummary[]>([])
  const [query,setQuery]=useState('')
  const [details,setDetails]=useState<SaleDetails|null>(null)
  const [message,setMessage]=useState('')

  const load=async()=>{
    try{setSales(await window.raspechatkaPos.listSales())}catch(error){setMessage(error instanceof Error?error.message:String(error))}
  }
  const show=()=>{setOpen(true);setDetails(null);setMessage('');void load()}
  const filtered=useMemo(()=>{
    const text=query.trim().toLocaleLowerCase('ru')
    if(!text)return sales.slice(0,100)
    const digits=text.replace(/\D/g,'')
    return sales.filter((sale)=>{
      const haystack=[sale.receiptNumber,sale.customerName||'',paymentName(sale.paymentMethod),money(sale.totalMinor),new Date(sale.createdAt).toLocaleString('ru-RU')].join(' ').toLocaleLowerCase('ru')
      return haystack.includes(text)||(digits&&String(sale.totalMinor).includes(digits))
    }).slice(0,100)
  },[sales,query])

  const openDetails=async(id:string)=>{
    try{setDetails(await window.raspechatkaPos.getSale(id))}catch(error){setMessage(error instanceof Error?error.message:String(error))}
  }
  const print=async(kind:'fiscal-copy'|'commodity')=>{
    if(!details)return
    try{const result=await window.raspechatkaPos.printSale(details.id,kind);setMessage(result.message)}catch(error){setMessage(error instanceof Error?error.message:String(error))}
  }

  return <>
    <button className="pilot-floating receipt-search-button" onClick={show}>⌕ Найти чек</button>
    {open&&<div className="pilot-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget)setOpen(false)}}>
      <section className="pilot-modal receipt-explorer">
        <header><div><small>ИСТОРИЯ ПРОДАЖ</small><h2>{details?'Чек '+details.receiptNumber:'Поиск чека'}</h2></div><button onClick={()=>setOpen(false)}>×</button></header>
        {!details?<>
          <label className="pilot-search"><span>⌕</span><input autoFocus value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Номер чека, покупатель, сумма, способ оплаты или дата"/></label>
          <div className="receipt-explorer-list">
            {filtered.map((sale)=><button key={sale.id} onClick={()=>void openDetails(sale.id)}>
              <div><b>{sale.receiptNumber}</b><small>{new Date(sale.createdAt).toLocaleString('ru-RU')} · {sale.customerName||'Розничный покупатель'}</small></div>
              <span>{paymentName(sale.paymentMethod)}</span><strong>{money(sale.totalMinor)}</strong>
            </button>)}
            {!filtered.length&&<div className="pilot-empty">Ничего не найдено</div>}
          </div>
        </>:<>
          <div className="receipt-detail-summary">
            <div><small>Дата</small><b>{new Date(details.createdAt).toLocaleString('ru-RU')}</b></div>
            <div><small>Покупатель</small><b>{details.customerName||'Розничный покупатель'}</b></div>
            <div><small>Оплата</small><b>{details.payments.map((p)=>paymentName(p.method)).join(' + ')}</b></div>
            <div><small>Итого</small><strong>{money(details.totalMinor)}</strong></div>
          </div>
          <div className="receipt-detail-lines">
            {details.lines.map((line)=><article key={line.id}><div><b>{line.name}</b><small>{line.quantity} × {money(line.unitPriceMinor)}{line.discountPercent?` · скидка ${line.discountPercent}%`:''}</small></div><strong>{money(Math.round(line.quantity*line.unitPriceMinor*(1-(line.discountPercent||0)/100)))}</strong>{line.returnedQuantity>0&&<span>Возвращено: {line.returnedQuantity}</span>}</article>)}
          </div>
          {details.remotePaymentConfirmation&&<div className="remote-audit"><b>Удалённая оплата подтверждена кассиром</b><span>{new Date(details.remotePaymentConfirmation.confirmedAt).toLocaleString('ru-RU')}{details.remotePaymentConfirmation.confirmedBy?' · '+details.remotePaymentConfirmation.confirmedBy:''}</span>{details.remotePaymentConfirmation.note&&<small>{details.remotePaymentConfirmation.note}</small>}</div>}
          <div className="receipt-detail-actions"><button onClick={()=>setDetails(null)}>← К списку</button><button onClick={()=>void print('commodity')}>Товарный чек</button><button onClick={()=>void print('fiscal-copy')}>Копия фискального</button></div>
        </>}
        {message&&<div className="pilot-message">{message}</div>}
      </section>
    </div>}
  </>
}
