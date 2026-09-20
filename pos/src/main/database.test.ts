import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PosDatabase } from './database'

const folders:string[]=[]
const databases:PosDatabase[]=[]
const createDatabase=()=>{
  const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-'))
  folders.push(folder)
  const database=new PosDatabase(join(folder,'test.sqlite'))
  databases.push(database)
  return database
}
afterEach(()=>{
  databases.splice(0).forEach((database)=>database.close())
  folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))
})

describe('PosDatabase',()=>{
  it('creates the local catalog and holds a receipt',()=>{
    const database=createDatabase()
    expect(database.listProducts().length).toBeGreaterThan(0)
    const held=database.holdReceipt({label:'Тест',lines:[],discountPercent:0})
    expect(database.listHeldReceipts()[0].id).toBe(held.id)
    database.deleteHeldReceipt(held.id)
    expect(database.listHeldReceipts()).toHaveLength(0)
  })

  it('creates paid orders from a sale and keeps first lifecycle timestamps',()=>{
    const database=createDatabase()
    const shift=database.openShift({id:'shift-order',openedAt:'2026-09-06T10:00:00.000Z',cashierName:'Тест'})
    database.saveSale({id:'sale-order',clientRequestId:'request-order',shiftId:shift.id,totalMinor:2000,paymentMethod:'cash',fiscalNumber:'FD-ORDER',createdAt:'2026-09-06T10:01:00.000Z',receiptDiscountPercent:0,lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],payments:[{method:'cash',amountMinor:2000}]})
    const order=database.createOrderFromSale({saleId:'sale-order',phone:'+7 900 123-45-67',comment:'Срочная печать',dueAt:'2026-09-06T12:00:00.000Z'})
    expect(order.status).toBe('in_progress')
    expect(database.updateOrder({id:order.id,status:'ready'}).readyAt).toBeTruthy()
    const first=database.listOrders()[0]
    const again=database.updateOrder({id:order.id,status:'ready'})
    expect(again.readyAt).toBe(first.readyAt)
    expect(database.updateOrder({id:order.id,status:'issued'}).issuedAt).toBeTruthy()
  })

  it('never creates a second order for the same paid receipt',()=>{
    const database=createDatabase()
    const shift=database.openShift({id:'shift-order-duplicate',openedAt:'2026-09-06T10:00:00.000Z',cashierName:'Тест'})
    database.saveSale({
      id:'sale-order-duplicate',clientRequestId:'request-order-duplicate',shiftId:shift.id,totalMinor:2000,
      paymentMethod:'cash',fiscalNumber:'FD-DUP',createdAt:'2026-09-06T10:01:00.000Z',receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
      payments:[{method:'cash',amountMinor:2000}]
    })
    const first=database.createOrderFromSale({
      saleId:'sale-order-duplicate',phone:'+7 900 123-45-67',comment:'Первый заказ',dueAt:'2026-09-06T12:00:00.000Z'
    })
    database.updateOrder({id:first.id,status:'ready'})
    database.updateOrder({id:first.id,status:'issued'})
    expect(()=>database.createOrderFromSale({
      saleId:'sale-order-duplicate',phone:'+7 900 123-45-67',comment:'Повтор',dueAt:'2026-09-06T13:00:00.000Z'
    })).toThrow(/уже существует заказ/)
  })

  it('keeps legacy orders without lifecycle timestamps readable',()=>{
    const database=createDatabase()
    const legacy=database.createUnpaidOrder({
      phone:'+7 900 000-00-01',
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}]
    })
    expect(database.listOrders().find((order)=>order.id===legacy.id)).toMatchObject({
      status:'new',readyAt:null,issuedAt:null
    })
  })

  it('stores split payments, partial returns and cash operations',()=>{
    const database=createDatabase()
    const shift=database.openShift({id:'shift-1',openedAt:'2026-09-06T10:00:00.000Z',cashierName:'Тест'})
    database.saveSale({
      id:'sale-1',clientRequestId:'request-1',shiftId:shift.id,totalMinor:10000,
      paymentMethod:'mixed',fiscalNumber:'TEST-1',createdAt:'2026-09-06T10:01:00.000Z',
      receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать ч/б A4',quantity:2,unitPriceMinor:5000}],
      payments:[{method:'cash',amountMinor:4000,transactionId:'cash-1'},{method:'card',amountMinor:6000,transactionId:'card-1'}]
    })
    const sale=database.getSale('sale-1')
    expect(sale.paymentMethod).toBe('mixed')
    expect(sale.payments).toHaveLength(2)
    database.saveReturn({
      id:'return-1',clientRequestId:'return-request-1',saleId:'sale-1',shiftId:shift.id,
      totalMinor:5000,fiscalNumber:'RETURN-1',createdAt:'2026-09-06T10:02:00.000Z',
      lines:[{saleItemId:sale.lines[0].id,quantity:1,lineTotalMinor:5000}],
      payments:[{method:'cash',amountMinor:5000,transactionId:'refund-1'}]
    })
    database.addCashOperation('deposit',2000,'Размен')
    const summary=database.getShiftSummary()
    expect(summary.returnsMinor).toBe(5000)
    expect(summary.expectedCashMinor).toBe(1000)
    expect(database.getSale('sale-1').status).toBe('partially_returned')
    expect(database.pendingEvents()).toHaveLength(4)
  })

  it('caches the minimal OS customer directory and updates stock after sale and return',()=>{
    const database=createDatabase()
    database.replaceCustomers([{id:'client-1',name:'Иван',phone:'+7 900 111-22-33',discountPercent:7}])
    expect(database.listCustomers('2233')[0]).toEqual({id:'client-1',name:'Иван',phone:'+7 900 111-22-33',discountPercent:7})
    database.replaceProducts([{id:'paper',name:'Бумага',sku:'PAPER',category:'Товары',type:'product',uom:'шт',priceMinor:1000,stock:5,trackInventory:true}])
    const shift=database.openShift({id:'shift-stock',openedAt:'2026-09-06T11:00:00.000Z',cashierName:'Тест'})
    database.saveSale({
      id:'sale-stock',clientRequestId:'request-stock',shiftId:shift.id,totalMinor:2000,paymentMethod:'cash',
      fiscalNumber:'TEST-STOCK',createdAt:'2026-09-06T11:01:00.000Z',customerId:'client-1',customerName:'Иван',
      receiptDiscountPercent:0,lines:[{productId:'paper',name:'Бумага',quantity:2,unitPriceMinor:1000}],
      payments:[{method:'cash',amountMinor:2000}]
    })
    expect(database.listProducts().find((x)=>x.id==='paper')?.stock).toBe(3)
    const sale=database.getSale('sale-stock')
    database.saveReturn({id:'return-stock',clientRequestId:'return-request-stock',saleId:sale.id,shiftId:shift.id,
      totalMinor:1000,fiscalNumber:'RETURN-STOCK',createdAt:'2026-09-06T11:02:00.000Z',
      lines:[{saleItemId:sale.lines[0].id,quantity:1,lineTotalMinor:1000}],payments:[{method:'cash',amountMinor:1000}]})
    expect(database.listProducts().find((x)=>x.id==='paper')?.stock).toBe(4)
  })

  it('removes products and customers that are no longer returned by OS',()=>{
    const database=createDatabase()
    database.replaceProducts([
      {id:'active',name:'Активный',sku:'ACTIVE',category:'Товары',type:'product',uom:'шт',priceMinor:1000},
      {id:'removed',name:'Удалённый',sku:'REMOVED',category:'Товары',type:'product',uom:'шт',priceMinor:2000}
    ])
    database.replaceCustomers([
      {id:'active-client',name:'Активный клиент',phone:'+79000000001',discountPercent:5},
      {id:'removed-client',name:'Удалённый клиент',phone:'+79000000002',discountPercent:0}
    ])
    database.replaceProducts([
      {id:'active',name:'Активный',sku:'ACTIVE',category:'Товары',type:'product',uom:'шт',priceMinor:1000}
    ])
    database.replaceCustomers([{id:'active-client',name:'Активный клиент',phone:'+79000000001',discountPercent:5}])
    database.replaceCustomers([{id:'active-client',name:'Активный клиент',phone:'+79000000001',discountPercent:3}])
    expect(database.listProducts().map((x)=>x.id)).toEqual(['active'])
    expect(database.getCustomer('active-client')?.discountPercent).toBe(3)
    expect(database.getCustomer('removed-client')).toBeNull()
  })

  it('records trusted warehouse actions offline outside the sale assortment',()=>{
    const database=createDatabase()
    database.setWorkplaceData({
      schedule:[],
      scheduleMonth:{month:'2026-09',days:30,employees:[],entries:[]},
      myUpcomingShifts:[],
      operationalCatalog:[{
        id:'paper-hidden',name:'Бумага служебная',itemCode:'PAPER-HIDDEN',itemType:'Product',uom:'пачка',
        trackInventory:true,stock:5,storageAddress:'Шкаф 3 · верхняя полка'
      }],
      deliveries:[{
        id:'PO-1',supplier:'Поставщик',status:'Ожидается',items:[{
          purchaseOrderItemId:'POI-1',itemId:'paper-hidden',itemName:'Бумага служебная',itemCode:'PAPER-HIDDEN',
          uom:'пачка',orderedQuantity:4,receivedQuantity:0,remainingQuantity:4
        }]
      }],
      supplyRequests:[],
      cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},
      orders:[],
    })
    expect(database.listProducts().some((x)=>x.id==='paper-hidden')).toBe(false)
    database.openShift({id:'shift-work',openedAt:'2026-09-06T12:00:00.000Z',cashierId:'SHIFT-EMP',cashierName:'Николай'})
    const count=database.saveCashCount('opening',[{denominationMinor:100000,quantity:2}])
    expect(count).toMatchObject({totalMinor:200000,differenceMinor:0})
    expect(database.getShiftSummary().expectedCashMinor).toBe(200000)
    database.reportStockWriteOff({productId:'paper-hidden',quantity:1,reason:'Брак',comment:'Замята упаковка'},'EMP-1')
    database.createSupplyRequest({productId:'paper-hidden',itemName:'Клиент не должен переименовать',quantity:10},'EMP-1')
    database.createStockReceipt({purchaseOrderId:'PO-1',lines:[{purchaseOrderItemId:'POI-1',quantity:2}]},'EMP-1')
    for(let index=0;index<4;index+=1)database.recordCleanerVisit('Николай')
    expect(database.getWorkplaceData().cleaner.paymentDueMinor).toBe(200000)
    expect(database.getWorkplaceData().deliveries[0].items[0].remainingQuantity).toBe(2)
    database.payCleaner(200000)
    expect(database.getWorkplaceData().cleaner.paymentDueMinor).toBe(0)

    const events=database.pendingEvents()
    expect(events.map((x)=>x.eventType)).toEqual(expect.arrayContaining([
      'cash.counted','stock.write_off.requested','point.supply.requested','stock.receipt.requested','cleaner.visit.recorded','cleaner.paid'
    ]))
    const writeOff=events.find((x)=>x.eventType==='stock.write_off.requested')?.payload as Record<string,unknown>
    const need=events.find((x)=>x.eventType==='point.supply.requested')?.payload as Record<string,unknown>
    const receipt=events.find((x)=>x.eventType==='stock.receipt.requested')?.payload as Record<string,unknown>
    expect(writeOff.cashierId).toBe('EMP-1')
    expect(need).toMatchObject({cashierId:'EMP-1',productId:'paper-hidden',itemName:'Бумага служебная'})
    expect(receipt).toEqual({
      cashierId:'EMP-1',
      purchaseOrderId:'PO-1',
      lines:[{purchaseOrderItemId:'POI-1',quantity:2}],
    })
    expect(JSON.stringify(receipt)).not.toContain('rate')
    expect(receipt.cashierId).not.toBe('SHIFT-EMP')
    expect(database.pendingEvents().filter((x)=>x.eventType==='cash.deposited')).toHaveLength(0)
  })

  it('removes a fully received purchase order from the optimistic workplace snapshot',()=>{
    const database=createDatabase()
    database.setWorkplaceData({
      schedule:[],
      scheduleMonth:{month:'2026-09',days:30,employees:[],entries:[]},
      myUpcomingShifts:[],
      operationalCatalog:[],
      deliveries:[{
        id:'PO-FULL',supplier:'Поставщик',status:'Ожидается',items:[{
          purchaseOrderItemId:'POI-FULL',itemId:'item',itemName:'Товар',itemCode:'ITEM',
          uom:'шт',orderedQuantity:2,receivedQuantity:0,remainingQuantity:2
        }]
      }],
      supplyRequests:[],
      cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},
      orders:[],
    })
    database.createStockReceipt({
      purchaseOrderId:'PO-FULL',
      lines:[{purchaseOrderItemId:'POI-FULL',quantity:2}],
    },'EMP-1')
    expect(database.getWorkplaceData().deliveries).toEqual([])
  })

  it('assigns morning and evening explicitly and preserves them after restart',()=>{
    const database=createDatabase()
    const morning=database.openShift({id:'shift-morning',openedAt:'2026-09-06T06:00:00.000Z',cashierName:'Анна'})
    expect(morning.shiftType).toBe('Утро')
    database.closeShift()
    const evening=database.openShift({id:'shift-evening',openedAt:'2026-09-06T14:00:00.000Z',cashierName:'Анна'})
    expect(evening.shiftType).toBe('Вечер')
    expect(database.currentShift()?.shiftType).toBe('Вечер')
    database.closeShift()
    const nextMorning=database.openShift({id:'shift-next-day',openedAt:'2026-09-07T06:00:00.000Z',cashierName:'Анна'})
    expect(nextMorning.shiftType).toBe('Утро')
  })
})
