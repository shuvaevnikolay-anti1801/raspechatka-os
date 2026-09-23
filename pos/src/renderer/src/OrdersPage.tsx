import { PosButton } from './ui/PosButton'
import { PosField } from './ui/PosField'
import { PosModal } from './ui/PosModal'
import { useEffect, useMemo, useState } from 'react'
import type { CreateOrderFromSaleRequest, Order, SaleDetails, SaleSummary } from '../../shared/contracts'
import { formatMoney } from './money'
import {
  emptyOrderFormDraft, isOrderFormComplete, OrderFormFields, orderFormDraftFromOrder,
  toOrderFormPayload, type OrderFormDraft,
} from './OrderFormFields'

const short=(phone:string)=>{const digits=phone.replace(/\D/g,'');return digits.slice(-4)||'—'}
const statusName=(status:Order['status'])=>status==='ready'?'Готов к выдаче':status==='issued'?'Выдан':status==='cancelled'?'Отменён':'В работе'
const overdue=(order:Order)=>Boolean(order.dueAt&&new Date(order.dueAt).getTime()<Date.now()&&!['ready','issued','cancelled'].includes(order.status))
const dueTime=(order:Order)=>order.dueAt?new Date(order.dueAt).getTime():Number.MAX_SAFE_INTEGER

export const orderReceiptCustomerName=(sale:Pick<SaleSummary,'customerName'>)=>sale.customerName?.trim()||'Розничный покупатель'
export const formatOrderReceiptDate=(value:string)=>new Date(value).toLocaleString('ru-RU',{
  day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',
})
export const eligibleOrderSales=(sales:SaleSummary[],orders:Order[])=>{
  const used=new Set(orders.map((order)=>order.sourceSaleId).filter(Boolean))
  return sales.filter((sale)=>sale.status==='completed'&&!used.has(sale.id))
}
export const orderReceiptSelectorLabel=(sale:SaleSummary)=>[
  sale.receiptNumber,
  formatOrderReceiptDate(sale.createdAt),
  orderReceiptCustomerName(sale),
  sale.customerPhone?.trim(),
  formatMoney(sale.totalMinor),
].filter(Boolean).join(' · ')
export const resolveOrderSaleSelection=(sales:SaleSummary[],selectorValue:string)=>
  sales.find((sale)=>orderReceiptSelectorLabel(sale)===selectorValue)||null
export const isOrderCreateReady=(sale:SaleDetails|null,draft:OrderFormDraft)=>
  Boolean(sale&&sale.status==='completed'&&isOrderFormComplete(draft))
export const buildOrderFromSaleRequest=(sale:SaleDetails,draft:OrderFormDraft):CreateOrderFromSaleRequest=>({
  saleId:sale.id,
  ...toOrderFormPayload(draft),
})

export function OrderReceiptPreview({sale}:{sale:SaleDetails}){
  return <section className="order-selected-receipt" aria-label="Выбранный оплаченный чек">
    <div className="order-selected-receipt-summary">
      <span>{formatOrderReceiptDate(sale.createdAt)}</span>
      <b>{formatMoney(sale.totalMinor)}</b>
      <strong>{orderReceiptCustomerName(sale)}</strong>
    </div>
    <ul className="order-selected-receipt-lines">
      {sale.lines.map((line,index)=><li key={index}><span>{line.name}</span><b>× {line.quantity}</b></li>)}
    </ul>
  </section>
}

type Props={orders:Order[];onChanged:()=>Promise<void>;notify:(text:string)=>void}

export default function OrdersPage({orders,onChanged,notify}:Props){
  const [editing,setEditing]=useState<Order|null>(null)
  const [creating,setCreating]=useState(false)
  const active=useMemo(()=>orders
    .filter((order)=>order.paymentStatus==='paid'&&['new','in_progress','ready'].includes(order.status))
    .sort((a,b)=>{
      const aReady=a.status==='ready',bReady=b.status==='ready'
      if(aReady!==bReady)return aReady?1:-1
      const aOverdue=overdue(a),bOverdue=overdue(b)
      if(aOverdue!==bOverdue)return aOverdue?-1:1
      const due=dueTime(a)-dueTime(b)
      return due||a.createdAt.localeCompare(b.createdAt)
    }),[orders])

  const update=async(order:Order,status:Order['status'])=>{
    try{
      await window.raspechatkaPos.updateOrder({id:order.id,status})
      await onChanged()
      notify(status==='ready'?'Заказ готов к выдаче':'Заказ выдан')
    }catch(error){
      notify(error instanceof Error?error.message:String(error))
    }
  }

  return <main className="page records-page orders-page">
    <div className="page-heading orders-heading">
      <div><h1>Заказы</h1><p>Оплаченные работы, которые нужно изготовить и выдать клиенту.</p></div>
      <PosButton variant="primary" onClick={()=>setCreating(true)}>+ Создать заказ</PosButton>
    </div>

    <div className="data-table orders-table">
      <header>
        <span>Заказ</span><span>Телефон</span><span>Описание заказа</span><span>Оплата</span>
        <span>Создан</span><span>Дата выдачи</span><span>Статус</span><span>Действие</span>
      </header>
      {active.length?active.map((order)=><div key={order.id} className={overdue(order)?'order-row order-overdue':'order-row'}>
        <b className="order-number">№ {short(order.phone)}<small>{order.orderNumber}</small></b>
        <span className="order-phone">{order.phone}</span>
        <span className="order-description">{order.comment||'Без описания'}</span>
        <span className="order-payment"><b>Оплачено · {formatMoney(order.totalMinor)}</b>{order.fiscalNumber&&<small>чек {order.fiscalNumber}</small>}</span>
        <span>{new Date(order.createdAt).toLocaleString('ru-RU')}</span>
        <span className={overdue(order)?'order-due overdue':'order-due'}>
          {order.dueAt?new Date(order.dueAt).toLocaleString('ru-RU'):'Дата не указана'}
          {overdue(order)&&<small>Просрочен</small>}
        </span>
        <span className={'order-status '+order.status}>{statusName(order.status)}</span>
        <div className="order-actions">
          <PosButton variant="secondary" onClick={()=>setEditing(order)} title="Изменить телефон, способ связи, описание или дату выдачи">Изменить</PosButton>
          {order.status==='ready'
            ?<PosButton variant="primary" className="order-issued" onClick={()=>void update(order,'issued')}>Выдан</PosButton>
            :<PosButton variant="primary" onClick={()=>void update(order,'ready')}>Готово</PosButton>}
        </div>
      </div>):<div className="page-empty"><b>Активных заказов нет</b><span>Новые оплаченные заказы появятся здесь.</span></div>}
    </div>

    {editing&&<EditOrder order={editing} close={()=>setEditing(null)} saved={async()=>{
      setEditing(null);await onChanged();notify('Заказ сохранён')
    }}/>} 
    {creating&&<CreateOrder orders={orders} close={()=>setCreating(false)} saved={async()=>{
      setCreating(false);await onChanged();notify('Заказ создан и поставлен в работу')
    }}/>} 
  </main>
}

export function EditOrder({order,close,saved}:{order:Order;close:()=>void;saved:()=>Promise<void>}){
  const [draft,setDraft]=useState<OrderFormDraft>(()=>orderFormDraftFromOrder(order))
  const [error,setError]=useState('')
  const valid=isOrderFormComplete(draft)

  const submit=async()=>{
    setError('')
    try{
      await window.raspechatkaPos.updateOrder({id:order.id,...toOrderFormPayload(draft)})
      await saved()
    }catch(reason){
      setError(reason instanceof Error?reason.message:String(reason))
    }
  }

  return <PosModal open title="Изменить заказ" onClose={close} className="compact-modal" footer={
    <PosButton variant="primary" disabled={!valid} onClick={()=>void submit()}>Сохранить</PosButton>
  }>
    <OrderFormFields draft={draft} onChange={setDraft} className="order-modal-form"/>
    {error&&<div className="error-note">{error}</div>}
  </PosModal>
}

export function CreateOrder({orders,close,saved}:{orders:Order[];close:()=>void;saved:()=>Promise<void>}){
  const [sales,setSales]=useState<SaleSummary[]>([])
  const [loading,setLoading]=useState(true)
  const [selectorValue,setSelectorValue]=useState('')
  const [selectedSaleId,setSelectedSaleId]=useState('')
  const [selectedSale,setSelectedSale]=useState<SaleDetails|null>(null)
  const [detailLoading,setDetailLoading]=useState(false)
  const [draft,setDraft]=useState<OrderFormDraft>(()=>emptyOrderFormDraft())
  const [error,setError]=useState('')

  useEffect(()=>{
    let cancelled=false
    window.raspechatkaPos.listSales().then((rows)=>{
      if(cancelled)return
      setSales(eligibleOrderSales(rows,orders))
    }).catch((reason)=>{if(!cancelled)setError(reason instanceof Error?reason.message:String(reason))})
      .finally(()=>{if(!cancelled)setLoading(false)})
    return()=>{cancelled=true}
  },[orders])

  useEffect(()=>{
    let cancelled=false
    setSelectedSale(null)
    if(!selectedSaleId){setDetailLoading(false);return()=>{cancelled=true}}
    setDetailLoading(true)
    window.raspechatkaPos.getSale(selectedSaleId).then((sale)=>{
      if(cancelled)return
      if(sale.id!==selectedSaleId||sale.status!=='completed'){
        setError('Выбранный чек больше нельзя использовать для создания заказа')
        return
      }
      setSelectedSale(sale)
    }).catch((reason)=>{if(!cancelled)setError(reason instanceof Error?reason.message:String(reason))})
      .finally(()=>{if(!cancelled)setDetailLoading(false)})
    return()=>{cancelled=true}
  },[selectedSaleId])

  const valid=isOrderCreateReady(selectedSale,draft)
  const selectReceipt=(value:string)=>{
    setSelectorValue(value)
    setError('')
    setSelectedSale(null)
    const sale=resolveOrderSaleSelection(sales,value)
    setSelectedSaleId(sale?.id||'')
    setDraft((current)=>({...current,phone:sale?.customerPhone||''}))
  }

  const submit=async()=>{
    if(!selectedSale)return
    setError('')
    try{
      await window.raspechatkaPos.createOrderFromSale(buildOrderFromSaleRequest(selectedSale,draft))
      await saved()
    }catch(reason){
      setError(reason instanceof Error?reason.message:String(reason))
    }
  }

  return <PosModal open title="Создать заказ" onClose={close} layout="matrix" className="order-create-modal" footer={
    <PosButton variant="primary" disabled={!valid} onClick={()=>void submit()}>Создать заказ</PosButton>
  }>
    <div className="order-modal-form">
      <PosField label="Оплаченный чек *" helper="Начните вводить номер чека, покупателя или телефон">
        <input
          type="search"
          list="order-paid-sales"
          value={selectorValue}
          disabled={loading}
          placeholder={loading?'Загружаем чеки…':'Выберите оплаченный чек'}
          onChange={(event)=>selectReceipt(event.target.value)}
        />
      </PosField>
      <datalist id="order-paid-sales">
        {sales.map((sale)=><option key={sale.id} value={orderReceiptSelectorLabel(sale)}/>)}
      </datalist>
      {detailLoading&&<div className="settings-status">Загружаем чек…</div>}
      {selectedSale&&<OrderReceiptPreview sale={selectedSale}/>} 
      <OrderFormFields draft={draft} onChange={setDraft}/>
      {error&&<div className="error-note">{error}</div>}
      {!loading&&!sales.length&&<div className="settings-status">Нет свободных оплаченных чеков для нового заказа.</div>}
    </div>
  </PosModal>
}
