import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BootState } from '../../shared/contracts'

type Period='current_shift'|'today'|'yesterday'|'7d'|'30d'|'custom'|'all'
type ReceiptFilters={
  period:Period
  shiftExternalId?:string
  dateFrom?:string
  dateTo?:string
  cashierId?:string
  amountMinMinor?:number
  amountMaxMinor?:number
  paymentChannel?:'Cash'|'Card'|'QR'|''
  status?:'Draft'|'Posted'|'Cancelled'|''
  receiptType?:'Sale'|'Return'|''
}
type ReceiptFilterApi={setReceiptSearchFilters:(filters:ReceiptFilters)=>void}

const periodLabels:Record<Period,string>={
  current_shift:'Текущая смена',
  today:'Сегодня',
  yesterday:'Вчера',
  '7d':'7 дней',
  '30d':'30 дней',
  custom:'Период',
  all:'Все'
}

const rublesToMinor=(value:string)=>{
  if(!value.trim())return undefined
  const amount=Number(value.replace(',','.'))
  return Number.isFinite(amount)?Math.max(0,Math.round(amount*100)):undefined
}

function retriggerReceiptSearch(){
  const input=document.querySelector('.receipt-search input') as HTMLInputElement|null
  if(!input)return
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set
  if(!setter)return
  const next=input.value.endsWith(' ')?input.value.slice(0,-1):input.value+' '
  setter.call(input,next)
  input.dispatchEvent(new Event('input',{bubbles:true}))
}

export default function ReceiptFiltersBridge(){
  const [target,setTarget]=useState<Element|null>(null)
  const [boot,setBoot]=useState<BootState|null>(null)
  const [period,setPeriod]=useState<Period>('current_shift')
  const [dateFrom,setDateFrom]=useState('')
  const [dateTo,setDateTo]=useState('')
  const [cashierId,setCashierId]=useState('')
  const [amountMin,setAmountMin]=useState('')
  const [amountMax,setAmountMax]=useState('')
  const [paymentChannel,setPaymentChannel]=useState<ReceiptFilters['paymentChannel']>('')
  const [status,setStatus]=useState<ReceiptFilters['status']>('')
  const [receiptType,setReceiptType]=useState<ReceiptFilters['receiptType']>('')

  useEffect(()=>{
    const locate=()=>setTarget(document.querySelector('.receipt-search'))
    locate()
    const timer=window.setInterval(locate,250)
    return()=>window.clearInterval(timer)
  },[])

  useEffect(()=>{
    if(!target)return
    window.raspechatkaPos.getBootState().then(setBoot).catch(()=>setBoot(null))
  },[target])

  const filters=useMemo<ReceiptFilters>(()=>({
    period,
    shiftExternalId:boot?.shift?.id,
    dateFrom:period==='custom'&&dateFrom?dateFrom:undefined,
    dateTo:period==='custom'&&dateTo?dateTo:undefined,
    cashierId:cashierId||undefined,
    amountMinMinor:rublesToMinor(amountMin),
    amountMaxMinor:rublesToMinor(amountMax),
    paymentChannel,
    status,
    receiptType
  }),[period,boot?.shift?.id,dateFrom,dateTo,cashierId,amountMin,amountMax,paymentChannel,status,receiptType])

  useEffect(()=>{
    if(!target)return
    const api=window.raspechatkaPos as typeof window.raspechatkaPos&ReceiptFilterApi
    api.setReceiptSearchFilters(filters)
    const timer=window.setTimeout(retriggerReceiptSearch,0)
    return()=>window.clearTimeout(timer)
  },[filters,target])

  const reset=()=>{
    setPeriod('current_shift')
    setDateFrom('')
    setDateTo('')
    setCashierId('')
    setAmountMin('')
    setAmountMax('')
    setPaymentChannel('')
    setStatus('')
    setReceiptType('')
  }

  if(!target)return null
  return createPortal(
    <section className="receipt-filter-panel" aria-label="Фильтры чеков">
      <div className="receipt-periods">
        {(Object.keys(periodLabels) as Period[]).map((value)=><button key={value} className={period===value?'active':''} onClick={()=>setPeriod(value)}>{periodLabels[value]}</button>)}
      </div>
      <div className="receipt-filter-grid">
        {period==='custom'&&<>
          <label><span>Дата с</span><input type="date" value={dateFrom} onChange={(event)=>setDateFrom(event.target.value)}/></label>
          <label><span>Дата по</span><input type="date" value={dateTo} onChange={(event)=>setDateTo(event.target.value)}/></label>
        </>}
        <label><span>Кассир</span><select value={cashierId} onChange={(event)=>setCashierId(event.target.value)}><option value="">Все кассиры</option>{boot?.employees.map((employee)=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
        <label><span>Сумма от, ₽</span><input inputMode="decimal" value={amountMin} onChange={(event)=>setAmountMin(event.target.value)} placeholder="0"/></label>
        <label><span>Сумма до, ₽</span><input inputMode="decimal" value={amountMax} onChange={(event)=>setAmountMax(event.target.value)} placeholder="Без ограничения"/></label>
        <label><span>Оплата</span><select value={paymentChannel} onChange={(event)=>setPaymentChannel(event.target.value as ReceiptFilters['paymentChannel'])}><option value="">Любая</option><option value="Cash">Наличные</option><option value="Card">Карта</option><option value="QR">QR / СБП</option></select></label>
        <label><span>Статус</span><select value={status} onChange={(event)=>setStatus(event.target.value as ReceiptFilters['status'])}><option value="">Любой</option><option value="Posted">Проведён</option><option value="Draft">Черновик</option><option value="Cancelled">Отменён</option></select></label>
        <label><span>Тип</span><select value={receiptType} onChange={(event)=>setReceiptType(event.target.value as ReceiptFilters['receiptType'])}><option value="">Продажи и возвраты</option><option value="Sale">Продажа</option><option value="Return">Возврат</option></select></label>
        <button className="receipt-filter-reset" onClick={reset}>Сбросить фильтры</button>
      </div>
    </section>,
    target
  )
}
