import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Order } from '../../shared/contracts'
import OrdersPage, {
  ORDER_TABLE_COLUMNS, clampOrderColumnWidth, defaultOrderColumnWidths,
  formatOrderDateTime, orderTableGridTemplate,
} from './OrdersPage'

const order:Order={
  id:'internal-order-secret',
  orderNumber:'ORD-20260923-USER42',
  phone:'+7 900 111-22-33',
  contactMethod:'Telegram @client',
  lines:[],
  totalMinor:12500,
  paidMinor:12500,
  paymentStatus:'paid',
  status:'in_progress',
  comment:'Фотокнига с длинным описанием заказа для клиента',
  createdAt:'2026-09-23T10:15:37',
  dueAt:'2026-09-24T18:30:59',
  issuedAt:'2026-09-25T09:05:44',
  sourceSaleId:'source-sale-secret',
  sourceReceipt:'source-receipt-secret',
  fiscalNumber:'fiscal-secret',
}

describe('DEV-172 stage 4 orders table',()=>{
  it('keeps status first and exposes only business columns in the planned order',()=>{
    expect(ORDER_TABLE_COLUMNS.map((column)=>[column.key,column.label])).toEqual([
      ['status','Статус'],
      ['orderNumber','Заказ'],
      ['phone','Телефон'],
      ['contactMethod','Способ связи'],
      ['description','Описание заказа'],
      ['payment','Оплата'],
      ['createdAt','Создан'],
      ['dueAt','Дата выдачи'],
      ['issuedAt','Выдан'],
      ['actions','Действие'],
    ])
  })

  it('renders contact, paid label and minute-only dates without technical identifiers',()=>{
    const markup=renderToStaticMarkup(<OrdersPage orders={[order]} onChanged={async()=>undefined} notify={()=>undefined}/>)
    expect(markup).toContain('ORD-20260923-USER42')
    expect(markup).toContain('+7 900 111-22-33')
    expect(markup).toContain('Telegram @client')
    expect(markup).toContain('Фотокнига с длинным описанием заказа для клиента')
    expect(markup).toContain('Оплачено ·')
    expect(markup).toContain('23.09.2026 10:15')
    expect(markup).toContain('24.09.2026 18:30')
    expect(markup).toContain('25.09.2026 09:05')
    expect(markup).not.toContain('>10:15:37<')
    expect(markup).not.toContain('>18:30:59<')
    expect(markup).not.toContain('>09:05:44<')
    expect(markup).not.toContain('internal-order-secret')
    expect(markup).not.toContain('source-sale-secret')
    expect(markup).not.toContain('source-receipt-secret')
    expect(markup).not.toContain('fiscal-secret')
    expect((markup.match(/role="separator"/g)||[]).length).toBe(ORDER_TABLE_COLUMNS.length)
  })

  it('formats order datetimes deterministically to minutes',()=>{
    expect(formatOrderDateTime('2026-09-23T10:15:37')).toBe('23.09.2026 10:15')
    expect(formatOrderDateTime('2026-09-23T10:15:59')).toBe('23.09.2026 10:15')
    expect(formatOrderDateTime(undefined)).toBe('—')
    expect(formatOrderDateTime('not-a-date')).toBe('—')
  })

  it('clamps pointer resize widths to sensible per-column bounds',()=>{
    expect(clampOrderColumnWidth('status',1)).toBe(120)
    expect(clampOrderColumnWidth('status',180)).toBe(180)
    expect(clampOrderColumnWidth('status',999)).toBe(240)
    expect(clampOrderColumnWidth('description',50)).toBe(200)
    expect(clampOrderColumnWidth('description',321.4)).toBe(321)
    expect(clampOrderColumnWidth('description',900)).toBe(560)
    const widths=defaultOrderColumnWidths()
    expect(orderTableGridTemplate(widths)).toBe(ORDER_TABLE_COLUMNS.map((column)=>`${column.defaultWidth}px`).join(' '))
  })
})
