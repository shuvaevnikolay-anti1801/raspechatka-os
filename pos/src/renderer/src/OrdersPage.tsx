import { operatorError } from './operator-message'
import { PosButton } from './ui/PosButton'
import { PosField } from './ui/PosField'
import { PosModal } from './ui/PosModal'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ORDER_TABLE_COLUMNS, clampOrderColumnWidth, defaultOrderColumnWidths, normalizeOrderColumnWidths, type OrderColumnWidths, type OrderTableColumnKey, type CreateOrderFromSaleRequest, type Order, type SaleDetails, type SaleSummary } from '../../shared/contracts'
export { ORDER_TABLE_COLUMNS, clampOrderColumnWidth, defaultOrderColumnWidths } from '../../shared/contracts'
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

export const orderTableGridTemplate=(widths:OrderColumnWidths)=>
  ORDER_TABLE_COLUMNS.map((column)=>`minmax(0,${widths[column.key]}fr)`).join(' ')

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
    <p>Заказ {order.customerOrderNumber||'—'} будет отмечен как выданный клиенту.</p>
  </PosModal>
}

type Props={orders:Order[];onChanged:()=>Promise<void>;notify:(text:string)=>void}
type ResizeState={key:OrderTableColumnKey;pointerId:number;startX:number;startWidth:number}

export default function OrdersPage({orders,onChanged,notify}:Props){
  const [editing,setEditing]=useState<Order|null>(null)
  const [creating,setCreating]=useState(false)
  const [issuing,setIssuing]=useState<Order|null>(null)
  const [columnWidths,setColumnWidths]=useState<OrderColumnWidths>(()=>defaultOrderColumnWidths())
  const widthsRef=useRef(columnWidths)
  const resizeRef=useRef<ResizeState|null>(null)
  const changedRef=useRef(false)
  const loadPending=useRef(true)
  useEffect(()=>{
    let mounted=true
    void window.raspechatkaPos.getOrderTableColumnWidths().then((saved)=>{
      if(mounted&&loadPending.current){
        const widths=normalizeOrderColumnWidths(saved)
        widthsRef.current=widths
        setColumnWidths(widths)
      }
    }).catch(()=>undefined)
    return ()=>{mounted=false}
  },[])
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
        notify(operatorError(error,'orders'))
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
    loadPending.current=false
    const state={key,pointerId:event.pointerId,startX:event.clientX,startWidth:widthsRef.current[key]}
    resizeRef.current=state
    changedRef.current=false
    setResizing(state)
  }
  const moveResize=(key:OrderTableColumnKey,event:ReactPointerEvent<HTMLSpanElement>)=>{
    const state=resizeRef.current
    if(!state||state.key!==key||state.pointerId!==event.pointerId)return
    const width=clampOrderColumnWidth(key,state.startWidth+event.clientX-state.startX)
    if(width===widthsRef.current[key])return
    changedRef.current=true
    widthsRef.current={...widthsRef.current,[key]:width}
    setColumnWidths(widthsRef.current)
  }
  const endResize=(event:ReactPointerEvent<HTMLSpanElement>)=>{
    const state=resizeRef.current
    if(!state||state.pointerId!==event.pointerId)return
    const width=clampOrderColumnWidth(state.key,state.startWidth+event.clientX-state.startX)
    if(width!==widthsRef.current[state.key]){
      widthsRef.current={...widthsRef.current,[state.key]:width}
      setColumnWidths(widthsRef.current)
    }
    if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
    resizeRef.current=null
    setResizing(null)
    if(changedRef.current||width!==state.startWidth){
      loadPending.current=false
      void window.raspechatkaPos.saveOrderTableColumnWidths(widthsRef.current).catch(()=>undefined)
    }
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
        <strong className="order-number">{order.customerOrderNumber||'—'}</strong>
        <span className="order-phone" title={order.phone}>{order.phone}</span>
        <span className="order-contact" title={order.contactMethod||''}>{order.contactMethod||'—'}</span>
        <span className="order-description" title={order.comment||''}>{order.comment||'Без описания'}</span>
        <span className="order-payment"><b>Оплачено · {formatMoney(order.totalMinor)}</b></span>
        <time className="order-created" dateTime={order.createdAt}>{formatOrderDateTime(order.createdAt)}</time>
        <span className={overdue(order)?'order-due overdue':'order-due'}>
          <time dateTime={order.dueAt}>{formatOrderDateTime(order.dueAt)}</time>
          {overdue(order)&&<small>Просрочен</small>}
        </span>
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
      setError(operatorError(reason,'orders'))
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
    }).catch((reason)=>{if(!cancelled)setError(operatorError(reason,'orders'))})
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
    }).catch((reason)=>{if(!cancelled)setError(operatorError(reason,'orders'))})
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
      setError(operatorError(reason,'orders'))
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
