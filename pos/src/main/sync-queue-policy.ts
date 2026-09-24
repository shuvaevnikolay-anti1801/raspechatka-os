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

/** Manual actions apply only to unsent outbox rows, regardless of event type. */
export const canCancelSyncQueueEvent=(event:OutboxQueueItem,blocked=false):boolean=>
  !blocked&&(event.status==='pending'||event.status==='problem')

export const canRetrySyncQueueEvent=(event:OutboxQueueItem,blocked:boolean):boolean=>
  !blocked&&(event.status==='pending'||event.status==='problem')
