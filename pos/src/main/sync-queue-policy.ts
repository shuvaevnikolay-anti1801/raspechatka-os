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

/** No generic cancellation is safe for committed local facts or uncertain server acceptance. */
export const canCancelSyncQueueEvent=(_event:OutboxQueueItem):false=>false

/** Only a due pending owner-domain event can request another ordinary sync cycle. */
export function canRetrySyncQueueEvent(event:OutboxQueueItem,blocked:boolean,now=Date.now()):boolean{
  if(blocked||event.status!=='pending'||!retryableSyncEvents.has(event.eventType))return false
  if(event.nextAttemptAt&&(!Number.isFinite(Date.parse(event.nextAttemptAt))||Date.parse(event.nextAttemptAt)>now))return false
  if(event.eventType==='order.updated'){
    const payload=event.payload as {updatedAt?:unknown}|null
    if(!payload||typeof payload.updatedAt!=='string'||!Number.isFinite(Date.parse(payload.updatedAt)))return false
  }
  return true
}
