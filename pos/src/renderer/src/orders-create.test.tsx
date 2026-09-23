import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Order, SaleDetails, SaleSummary } from '../../shared/contracts'
import {
  buildOrderFromSaleRequest, CreateOrder, eligibleOrderSales, isOrderCreateReady,
  OrderReceiptPreview, orderReceiptSelectorLabel, resolveOrderSaleSelection,
} from './OrdersPage'
import type { OrderFormDraft } from './OrderFormFields'

const summary=(overrides:Partial<SaleSummary>={}):SaleSummary=>({
  id:'sale-canonical-1',
  receiptNumber:'КЧ-1042',
  totalMinor:12500,
  returnedMinor:0,
  paymentMethod:'cash',
  customerName:'Иван Петров',
  customerPhone:'+7 900 111-22-33',
  createdAt:'2026-09-23T10:15:37.000Z',
  status:'completed',
  ...overrides,
})

const detail=(overrides:Partial<SaleDetails>={}):SaleDetails=>({
  ...summary(),
  lines:[
    {id:101,productId:'technical-product-a',name:'Фотокнига A4',quantity:2,unitPriceMinor:5000,returnedQuantity:0},
    {id:102,productId:'technical-product-b',name:'Ламинация',quantity:1.5,unitPriceMinor:1667,returnedQuantity:0},
  ],
  payments:[{method:'cash',amountMinor:12500}],
  ...overrides,
})

const draft:OrderFormDraft={
  phone:'+7 900 111-22-33',
  contactMethod:'Telegram',
  dueAt:'2026-09-24T18:30',
  comment:'Фотокнига к вечеру',
}

const usedOrder:Order={
  id:'order-1',orderNumber:'ORD-1',phone:'+7 900 000-00-00',lines:[],totalMinor:100,paidMinor:100,
  paymentStatus:'paid',status:'in_progress',createdAt:'2026-09-23T10:00:00.000Z',sourceSaleId:'sale-used',
}

describe('DEV-172 stage 3 paid receipt selector',()=>{
  it('requires a selected canonical completed sale and preserves existing completed-only eligibility',()=>{
    const completed=summary({id:'sale-open'})
    const partial=summary({id:'sale-partial',status:'partially_returned',returnedMinor:100})
    const returned=summary({id:'sale-returned',status:'returned',returnedMinor:12500})
    const used=summary({id:'sale-used'})
    expect(eligibleOrderSales([completed,partial,returned,used],[usedOrder]).map((sale)=>sale.id)).toEqual(['sale-open'])
    expect(isOrderCreateReady(null,draft)).toBe(false)
    expect(isOrderCreateReady(detail({id:'sale-open'}),draft)).toBe(true)
  })

  it('uses the selector itself for practical search and never resolves arbitrary technical ids',()=>{
    const first=summary({id:'internal-sale-1',receiptNumber:'КЧ-1042',customerName:'Иван Петров',customerPhone:'+7 900 111-22-33'})
    const second=summary({id:'internal-sale-2',receiptNumber:'КЧ-2048',customerName:'Анна Смирнова',customerPhone:'+7 900 444-55-66'})
    const firstLabel=orderReceiptSelectorLabel(first)
    const secondLabel=orderReceiptSelectorLabel(second)
    expect(firstLabel).toContain('КЧ-1042')
    expect(firstLabel).toContain('Иван Петров')
    expect(firstLabel).toContain('+7 900 111-22-33')
    expect(firstLabel).not.toContain('internal-sale-1')
    expect(resolveOrderSaleSelection([first,second],firstLabel)?.id).toBe('internal-sale-1')
    expect(resolveOrderSaleSelection([first,second],'')).toBeNull()
    expect(resolveOrderSaleSelection([first,second],'internal-sale-2')).toBeNull()
    expect(resolveOrderSaleSelection([first,second],secondLabel)?.id).toBe('internal-sale-2')

    const markup=renderToStaticMarkup(<CreateOrder orders={[]} close={()=>undefined} saved={async()=>undefined}/>)
    expect(markup).toContain('type="search"')
    expect(markup).toContain('Оплаченный чек *')
    expect(markup).not.toContain('Найти чек')
  })

  it('renders canonical preview with retail fallback, minute precision and every line quantity without technical ids',()=>{
    const sale=detail({
      id:'internal-sale-preview',
      customerName:'',
      lines:[
        {id:501,productId:'TECH-A',name:'Печать фото 10×15',quantity:3,unitPriceMinor:2000,returnedQuantity:0},
        {id:502,productId:'TECH-B',name:'Переплёт',quantity:1.5,unitPriceMinor:4333,returnedQuantity:0},
      ],
    })
    const markup=renderToStaticMarkup(<OrderReceiptPreview sale={sale}/>)
    expect(markup).toContain('Розничный покупатель')
    expect(markup).toContain('Печать фото 10×15')
    expect(markup).toContain('× 3')
    expect(markup).toContain('Переплёт')
    expect(markup).toContain('× 1.5')
    expect(markup).toContain('125 ₽')
    expect(markup).not.toContain(':37')
    expect(markup).not.toContain('internal-sale-preview')
    expect(markup).not.toContain('TECH-A')
    expect(markup).not.toContain('TECH-B')
    expect(markup).not.toContain('501')
    expect(markup).not.toContain('502')
  })

  it('submits the exact canonical selected source sale id with the shared order form payload',()=>{
    const selected=detail({id:'canonical-selected-sale'})
    expect(buildOrderFromSaleRequest(selected,draft)).toEqual({
      saleId:'canonical-selected-sale',
      phone:'+7 900 111-22-33',
      contactMethod:'Telegram',
      dueAt:'2026-09-24T18:30',
      comment:'Фотокнига к вечеру',
    })
  })
})
