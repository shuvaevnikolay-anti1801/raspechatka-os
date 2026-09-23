import { PosButton } from './ui/PosButton'
import { PosField } from './ui/PosField'
import { PosModal } from './ui/PosModal'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { CreateOrderFromSaleRequest, Order, SaleDetails, SaleSummary } from '../../shared/contracts'
import { formatMoney } from './money'
import {
  emptyOrderFormDraft, isOrderFormComplete, OrderFormFields, orderFormDraftFromOrder,
  toOrderFormPayload, type OrderFormDraft,
} from './OrderFormFields'
import './orders-table.css'

const statusName=(status:Order['status'])=>status==='ready'?'Готов к выдаче':status==='issued'?'Выдан':status==='cancelled'?'Отменён':'В работе'
const overdue=(order:Order)=>Boolean(order.dueAt&&new Date(order.dueAt).getTime()<Date.now()&&!['ready','issued','cancelled'].includes(order.status))
const dueTime=(order:Order)=>order.dueAt?new Date(order.dueAt).getTime():Number.MAX_SAFE_INTEGER
const pad2=(value:number)=>String(value).padStart(2,'0')

export const formatOrderDateTime=(value?:string|null)=>{
  if(!value)return '—'
  const date=new Date(value)
  if(Number.isNaN(date.getTime()))return '—'
  return `${pad2(date.getDate())}.${pad2(date.getMonth()+1)}.${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export type OrderTableColumnKey='status'|'orderNumber'|'phone'|'contactMethod'|'description'|'payment'|'createdAt'|'dueAt'|'issuedAt'|'actions'
export type OrderTableColumn={key:OrderTableColumnKey;label:string;defaultWidth:number;minWidth:number;maxWidth:number}
export const ORDER_TABLE_COLUMNS:readonly OrderTableColumn[]=[
  {key:'status',label:'Статус',defaultWidth:150,minWidth:120,maxWidth:240},
  {key:'orderNumber',label:'Заказ',defaultWidth:180,minWidth:130,maxWidth:300},
  {key:'phone',label:'Телефон',defaultWidth:175,minWidth:150,maxWidth:280},
  {key:'contactMethod',label:'Способ связи',defaultWidth:185,minWidth:130,maxWidth:360},
  {key:'description',label:'Описание заказа',defaultWidth:280,minWidth:200,maxWidth:560},
  {key:'payment',label:'Оплата',defaultWidth:190,minWidth:160,maxWidth:280},
  {key:'createdAt',label:'Создан',defaultWidth:165,minWidth:145,maxWidth:230},
  {key:'dueAt',label:'Дата выдачи',defaultWidth:165,minWidth:145,maxWidth:230},
  {key:'issuedAt',label:'Выдан',defaultWidth:165,minWidth:145,maxWidth:230},
  {key:'actions',label:'Действие',defaultWidth:210,minWidth:180,maxWidth:340},
]
export type OrderColumnWidths=Record<OrderTableColumnKey,number>
export const defaultOrderColumnWidths=()=>Object.fromEntries(
  ORDER_TABLE_COLUMNS.map((column)=>[column.key,column.defaultWidth]),
) as OrderColumnWidths
export const clampOrderColumnWidth=(key:OrderTableColumnKey,width:number)=>{
  const column=ORDER_TABLE_COLUMNS.find((candidate)=>candidate.key===key)
  if(!column)return Math.round(width)
  return Math.min(column.maxWidth,Math.max(column.minWidth,Math.round(width)))
}
export const orderTableGridTemplate=(widths:OrderColumnWidths)=>
  ORDER_TABLE_COLUMNS.map((column)=>`${widths[column.key]}px`).join(' ')

export const orderReceiptCustomerName=(sale:Pick<SaleSummary,'customerName'>)=>sale.customerName?.trim()||'Розничный покупатель'
export const formatOrderReceiptDate=(value:string)=>formatOrderDateTime(value)
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

export type OrderStatusUpdateResult<T>={started:boolean;value?:T}
export async function runSingleOrderStatusUpdate<T>(pending:Set<string>,orderId:string,action:()=>Promise<T>):Promise<OrderStatusUpdateResult<T>>{
  if(pending.has(orderId))return {started:false}
  pending.add(orderId)
  try{
    return {started:true,value:await action()}
  }finally{
    pending.delete(orderId)
  }
}

export function IssueOrderConfirmation({order,pending,onConfirm,onCancel}:{
  order:Order;pending:boolean;onConfirm:()=>Promise<void>|void;onCancel:()=>void
}){
  return <PosModal
    open
    title="Подтвердить выдачу заказа?"
    layout="action"
    className="order-issue-confirmation"
    closeDisabled={pending}
    onClose={onCancel}
    footer={<>
      <PosButton variant="secondary" disabled={pending} onClick={onCancel}>Отмена</PosButton>
      <PosButton variant="primary" disabled={pending} onClick={()=>void onConfirm()}>Подтверждаю</PosButton>
    </>}
  >
    <p>Заказ {order.orderNumber} будет отмечен как выданный клиенту.</p>
  </PosModal>
}

type Props={orders:Order[];onChanged:()=>Promise<void>;notify:(text:string)=>void}
type ResizeState={key:OrderTableColumnKey;pointerId:number;startX:number;startWidth:number}

export default function OrdersPage({orders,onChanged,notify}:Props){
  const [editing,setEditing]=useState<Order|null>(null)
  const [creating,setCreating]=useState(false)
  const [issuing,setIssuing]=useState<Order|null>(null)
  const [columnWidths,setColumnWidths]=useState<OrderColumnWidths>(()=>defaultOrderColumnWidths())
  const [resizing,setResizing]=useState<ResizeState|null>(null)
  const [pendingStatusOrderIds,setPendingStatusOrderIds]=useState<Set<string>>(()=>new Set())
  const pendingStatusUpdates=useRef(new Set<string>())
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
  const gridTemplateColumns=orderTableGridTemplate(columnWidths)
  const issuePending=Boolean(issuing&&pendingStatusOrderIds.has(issuing.id))

  const setStatusPending=(orderId:string,pending:boolean)=>{
    setPendingStatusOrderIds((current)=>{
      const next=new Set(current)
      if(pending)next.add(orderId)
      else next.delete(orderId)
      return next
    })
  }

  const update=async(order:Order,status:Order['status'])=>{
    const result=await runSingleOrderStatusUpdate(pendingStatusUpdates.current,order.id,async()=>{
      setStatusPending(order.id,true)
      try{
        await window.raspechatkaPos.updateOrder({id:order.id,status})
        await onChanged()
        notify(status==='ready'?'Заказ готов к выдаче':'Заказ выдан')
        return true
      }catch(error){
        notify(error instanceof Error?error.message:String(error))
        return false
      }finally{
        setStatusPending(order.id,false)
      }
    })
    return result.started?Boolean(result.value):false
  }

  const confirmIssue=async()=>{
    if(!issuing)return
    const target=issuing
    if(await update(target,'issued'))setIssuing(null)
  }
  const cancelIssue=()=>{
    if(issuePending)return
    setIssuing(null)
  }

  const beginResize=(key:OrderTableColumnKey,event:ReactPointerEvent<HTMLSpanElement>)=>{
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setResizing({key,pointerId:event.pointerId,startX:event.clientX,startWidth:columnWidths[key]})
  }
  const moveResize=(key:OrderTableColumnKey,event:ReactPointerEvent<HTMLSpanElement>)=>{
    if(!resizing||resizing.key!==key||resizing.pointerId!==event.pointerId)return
    const width=clampOrderColumnWidth(key,resizing.startWidth+event.clientX-resizing.startX)
    setColumnWidths((current)=>current[key]===width?current:{...current,[key]:width})
  }
  const endResize=(event:ReactPointerEvent<HTMLSpanElement>)=>{
    if(!resizing||resizing.pointerId!==event.pointerId)return
    if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
    setResizing(null)
  }

  return <main className="page records-page orders-page">
    <div className="page-heading orders-heading">
      <div><h1>Заказы</h1><p>Оплаченные работы, которые нужно изготовить и выдать клиенту.</p></div>
      <PosButton variant="primary" onClick={()=>setCreating(true)}>+ Создать заказ</PosButton>
    </div>

    <div className="data-table orders-table">
      <header style={{gridTemplateColumns}}>
        {ORDER_TABLE_COLUMNS.map((column)=><span className="orders-column-heading" key={column.key}>
          <span>{column.label}</span>
          <span
            className={resizing?.key===column.key?'orders-column-resizer resizing':'orders-column-resizer'}
            role="separator"
            aria-orientation="vertical"
            aria-label={`Изменить ширину колонки «${column.label}»`}
            onPointerDown={(event)=>beginResize(column.key,event)}
            onPointerMove={(event)=>moveResize(column.key,event)}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
        </span>)}
      </header>
      {active.length?active.map((order)=><div key={order.id} className={overdue(order)?'order-row order-overdue':'order-row'} style={{gridTemplateColumns}}>
        <span className={'order-status '+order.status}>{statusName(order.status)}</span>
        <strong className="order-number" title={order.orderNumber}>{order.orderNumber}</strong>
        <span className="order-phone" title={order.phone}>{order.phone}</span>
        <span className="order-contact" title={order.contactMethod||''}>{order.contactMethod||'—'}</span>
        <span className="order-description" title={order.comment||''}>{order.comment||'Без описания'}</span>
        <span className="order-payment"><b>Оплачено · {formatMoney(order.totalMinor)}</b></span>
        <time className="order-created" dateTime={order.createdAt}>{formatOrderDateTime(order.createdAt)}</time>
        <span className={overdue(order)?'order-due overdue':'order-due'}>
          <time dateTime={order.dueAt}>{formatOrderDateTime(order.dueAt)}</time>
          {overdue(order)&&<small>Просрочен</small>}
        </span>
        <time className="order-issued-at" dateTime={order.issuedAt}>{formatOrderDateTime(order.issuedAt)}</time>
        <div className="order-actions">
          <PosButton variant="secondary" onClick={()=>setEditing(order)} title="Изменить телефон, способ связи, описание или дату выдачи">Изменить</PosButton>
          {order.status==='ready'
            ?<PosButton variant="primary" className="order-issued" disabled={pendingStatusOrderIds.has(order.id)} onClick={()=>setIssuing(order)}>Выдан</PosButton>
            :<PosButton variant="primary" disabled={pendingStatusOrderIds.has(order.id)} onClick={()=>void update(order,'ready')}>Готово</PosButton>}
        </div>
      </div>):<div className="page-empty"><b>Активных заказов нет</b><span>Новые оплаченные заказы появятся здесь.</span></div>}
    </div>

    {issuing&&<IssueOrderConfirmation order={issuing} pending={issuePending} onConfirm={confirmIssue} onCancel={cancelIssue}/>} 
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