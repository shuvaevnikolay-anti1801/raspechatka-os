import { PosButton } from './ui/PosButton'
import { PosField } from './ui/PosField'
import { PosModal } from './ui/PosModal'
import { useEffect, useMemo, useState } from 'react'
import type { Order, SaleSummary } from '../../shared/contracts'
import { formatMoney } from './money'

const short=(phone:string)=>{const digits=phone.replace(/\D/g,'');return digits.slice(-4)||'—'}
const statusName=(status:Order['status'])=>status==='ready'?'Готов к выдаче':status==='issued'?'Выдан':status==='cancelled'?'Отменён':'В работе'
const overdue=(order:Order)=>Boolean(order.dueAt&&new Date(order.dueAt).getTime()<Date.now()&&!['ready','issued','cancelled'].includes(order.status))
const dueTime=(order:Order)=>order.dueAt?new Date(order.dueAt).getTime():Number.MAX_SAFE_INTEGER

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
        <span>Создан</span><span>Срок готовности</span><span>Статус</span><span>Действие</span>
      </header>
      {active.length?active.map((order)=><div key={order.id} className={overdue(order)?'order-row order-overdue':'order-row'}>
        <b className="order-number">№ {short(order.phone)}<small>{order.orderNumber}</small></b>
        <span className="order-phone">{order.phone}</span>
        <span className="order-description">{order.comment||'Без описания'}</span>
        <span className="order-payment"><b>Оплачено · {formatMoney(order.totalMinor)}</b>{order.fiscalNumber&&<small>чек {order.fiscalNumber}</small>}</span>
        <span>{new Date(order.createdAt).toLocaleString('ru-RU')}</span>
        <span className={overdue(order)?'order-due overdue':'order-due'}>
          {order.dueAt?new Date(order.dueAt).toLocaleString('ru-RU'):'Срок не указан'}
          {overdue(order)&&<small>Просрочен</small>}
        </span>
        <span className={'order-status '+order.status}>{statusName(order.status)}</span>
        <div className="order-actions">
          <PosButton variant="secondary" onClick={()=>setEditing(order)} title="Изменить телефон, описание или срок">Изменить</PosButton>
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

function EditOrder({order,close,saved}:{order:Order;close:()=>void;saved:()=>Promise<void>}){
  const [phone,setPhone]=useState(order.phone)
  const [comment,setComment]=useState(order.comment||'')
  const [dueAt,setDueAt]=useState(order.dueAt||'')
  const [error,setError]=useState('')
  const valid=phone.replace(/\D/g,'').length>=5&&Boolean(comment.trim())&&Boolean(dueAt)

  const submit=async()=>{
    setError('')
    try{
      await window.raspechatkaPos.updateOrder({id:order.id,phone,comment,dueAt})
      await saved()
    }catch(reason){
      setError(reason instanceof Error?reason.message:String(reason))
    }
  }

  return <PosModal open title="Изменить заказ" onClose={close} className="compact-modal" footer={
    <PosButton variant="primary" disabled={!valid} onClick={()=>void submit()}>Сохранить</PosButton>
  }>
    <div className="order-modal-form">
      <PosField label="Телефон *"><input value={phone} onChange={(event)=>setPhone(event.target.value)}/></PosField>
      <PosField label="Описание заказа *" size="textarea"><textarea value={comment} onChange={(event)=>setComment(event.target.value)}/></PosField>
      <PosField label="Срок готовности *"><input type="datetime-local" value={dueAt} onChange={(event)=>setDueAt(event.target.value)}/></PosField>
      {error&&<div className="error-note">{error}</div>}
    </div>
  </PosModal>
}

function CreateOrder({orders,close,saved}:{orders:Order[];close:()=>void;saved:()=>Promise<void>}){
  const [sales,setSales]=useState<SaleSummary[]>([])
  const [loading,setLoading]=useState(true)
  const [query,setQuery]=useState('')
  const [saleId,setSaleId]=useState('')
  const [phone,setPhone]=useState('')
  const [comment,setComment]=useState('')
  const [dueAt,setDueAt]=useState('')
  const [error,setError]=useState('')

  useEffect(()=>{
    let cancelled=false
    window.raspechatkaPos.listSales().then((rows)=>{
      if(cancelled)return
      const used=new Set(orders.map((order)=>order.sourceSaleId).filter(Boolean))
      setSales(rows.filter((sale)=>sale.status==='completed'&&!used.has(sale.id)))
    }).catch((reason)=>{if(!cancelled)setError(reason instanceof Error?reason.message:String(reason))})
      .finally(()=>{if(!cancelled)setLoading(false)})
    return()=>{cancelled=true}
  },[orders])

  const text=query.trim().toLocaleLowerCase('ru-RU')
  const matches=sales.filter((sale)=>!text||(sale.receiptNumber+' '+(sale.customerName||'')+' '+(sale.customerPhone||''))
    .toLocaleLowerCase('ru-RU').includes(text)).slice(0,30)
  const selected=sales.find((sale)=>sale.id===saleId)
  const valid=Boolean(saleId)&&phone.replace(/\D/g,'').length>=5&&Boolean(comment.trim())&&Boolean(dueAt)

  const submit=async()=>{
    setError('')
    try{
      await window.raspechatkaPos.createOrderFromSale({saleId,phone,comment,dueAt})
      await saved()
    }catch(reason){
      setError(reason instanceof Error?reason.message:String(reason))
    }
  }

  return <PosModal open title="Создать заказ" onClose={close} layout="matrix" className="order-create-modal" footer={
    <PosButton variant="primary" disabled={!valid} onClick={()=>void submit()}>Создать заказ</PosButton>
  }>
    <div className="order-modal-form">
      <PosField label="Найти чек"><input className="order-receipt-search" placeholder="Номер, телефон или покупатель" value={query} onChange={(event)=>setQuery(event.target.value)}/></PosField>
      <PosField label="Оплаченный чек *"><select value={saleId} disabled={loading} onChange={(event)=>{
        const id=event.target.value
        setSaleId(id)
        const sale=sales.find((item)=>item.id===id)
        if(sale?.customerPhone)setPhone(sale.customerPhone)
      }}>
        <option value="">{loading?'Загружаем чеки…':'Выберите чек'}</option>
        {matches.map((sale)=><option key={sale.id} value={sale.id}>{sale.receiptNumber} · {sale.customerName||'Покупатель'} · {formatMoney(sale.totalMinor)}</option>)}
      </select></PosField>
      {selected&&<div className="order-selected-receipt"><span>Оплачено</span><b>{formatMoney(selected.totalMinor)}</b><small>{selected.receiptNumber} · {new Date(selected.createdAt).toLocaleString('ru-RU')}</small></div>}
      <div className="order-modal-compact-fields">
        <PosField label="Телефон *"><input value={phone} onChange={(event)=>setPhone(event.target.value)} placeholder="+7 900 000-00-00"/></PosField>
        <PosField label="Срок готовности *"><input type="datetime-local" value={dueAt} onChange={(event)=>setDueAt(event.target.value)}/></PosField>
      </div>
      <PosField label="Описание заказа *" size="textarea"><textarea value={comment} onChange={(event)=>setComment(event.target.value)} placeholder="Что нужно изготовить"/></PosField>
      {error&&<div className="error-note">{error}</div>}
      {!loading&&!sales.length&&<div className="settings-status">Нет свободных оплаченных чеков для нового заказа.</div>}
    </div>
  </PosModal>
}
