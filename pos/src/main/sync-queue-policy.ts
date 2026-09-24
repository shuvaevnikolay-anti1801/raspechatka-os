import type { OutboxQueueItem } from '../shared/contracts'

export const syncEventLabels:Record<string,string>={
  'order.created':'Новый заказ',
  'order.updated':'Обновление заказа',
  'stock.write_off.requested':'Списание товара',
  'stock.receipt.requested':'Приёмка товара',
  'point.supply.requested':'Заявка на снабжение',
  'cleaner.visit.recorded':'Визит уборщика',
  'shift.opened':'Открытие смены',
  'shift.closed':'Закрытие смены',
  'sale.completed':'Продажа',
  'sale.returned':'Возврат продажи',
  'cash.deposited':'Внесение наличных',
  'cash.withdrawn':'Изъятие наличных',
  'cash.counted':'Пересчёт наличных',
}

const retryableSyncEvents=new Set([
  'order.created','order.updated','stock.write_off.requested',
  'stock.receipt.requested','point.supply.requested','cleaner.visit.recorded',
])

/** Explicit owner-domain opt-out; committed local documents remain intact. */
export const canCancelSyncQueueEvent=(event:OutboxQueueItem,blocked=false):boolean=>
  !blocked&&(event.status==='pending'||event.status==='problem')&&retryableSyncEvents.has(event.eventType)

/** Admin retry can override backoff or a problem state only for proven owner-domain keys. */
export function canRetrySyncQueueEvent(event:OutboxQueueItem,blocked:boolean):boolean{
  if(blocked||(event.status!=='pending'&&event.status!=='problem')||!retryableSyncEvents.has(event.eventType))return false
  if(event.eventType==='order.updated'){
    const payload=event.payload as {updatedAt?:unknown}|null
    if(!payload||typeof payload.updatedAt!=='string'||!Number.isFinite(Date.parse(payload.updatedAt)))return false
  }
  return true
}
