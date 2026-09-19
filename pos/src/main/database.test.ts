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

  it('persists banking evidence across restart and counts saved partial refunds',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-evidence-'))
    folders.push(folder)
    const path=join(folder,'evidence.sqlite')
    const first=new PosDatabase(path)
    const shift=first.openShift({id:'shift-evidence',openedAt:'2026-09-19T10:00:00.000Z',cashierName:'Тест'})
    first.saveSale({
      id:'sale-evidence',clientRequestId:'sale-evidence-request',shiftId:shift.id,totalMinor:2000,
      paymentMethod:'card',fiscalNumber:'FD-EVIDENCE',createdAt:'2026-09-19T10:01:00.000Z',
      receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
      payments:[{method:'card',amountMinor:2000,transactionId:'TRX-SALE',
        bankingEvidence:{provider:'inpas',adapter:'direct',terminalId:'40000037',
          referenceNumber:'RRN-SALE',terminalTransactionId:'TRX-SALE',responseCode:'00',
          amountMinor:2000,operationKind:'sale',startedAt:'2026-09-19T10:00:00.000Z'}}]
    })
    const sale=first.getSale('sale-evidence')
    first.saveReturn({
      id:'return-evidence',clientRequestId:'return-evidence-request',saleId:sale.id,shiftId:shift.id,
      totalMinor:500,fiscalNumber:'FD-RETURN',createdAt:'2026-09-19T10:02:00.000Z',
      lines:[{saleItemId:sale.lines[0].id,quantity:0.25,lineTotalMinor:500}],
      payments:[{method:'card',amountMinor:500,transactionId:'TRX-REFUND',
        bankingEvidence:{provider:'inpas',adapter:'direct',terminalId:'40000037',
          referenceNumber:'RRN-REFUND',originalReferenceNumber:'RRN-SALE',
          responseCode:'00',amountMinor:500,operationKind:'refund',
          startedAt:'2026-09-19T10:02:00.000Z'}}]
    })
    first.close()

    const second=new PosDatabase(path)
    databases.push(second)
    expect(second.getSale('sale-evidence').payments[0]).toMatchObject({
      transactionId:'TRX-SALE',
      bankingEvidence:{terminalId:'40000037',referenceNumber:'RRN-SALE',operationKind:'sale'}
    })
    expect(second.getReturnedPaymentMinor('sale-evidence','card')).toBe(500)
    const queued=second.pendingEvents().find((event)=>event.eventType==='sale.completed')
    expect(queued?.payload).toMatchObject({
      payments:[{bankingEvidence:{referenceNumber:'RRN-SALE'}}]
    })
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

  it('records the employee workplace actions offline',()=>{
    const database=createDatabase()
    database.replaceProducts([{id:'paper',name:'Бумага',sku:'PAPER',category:'Товары',type:'product',uom:'пачка',priceMinor:50000,stock:5,trackInventory:true,storageAddress:'Шкаф 3 · верхняя полка'}])
    database.openShift({id:'shift-work',openedAt:'2026-09-06T12:00:00.000Z',cashierName:'Николай'})
    const count=database.saveCashCount('opening',[{denominationMinor:100000,quantity:2}])
    expect(count).toMatchObject({totalMinor:200000,differenceMinor:0})
    expect(database.getShiftSummary().expectedCashMinor).toBe(200000)
    database.reportStockWriteOff({productId:'paper',quantity:1,reason:'Брак',comment:'Замята упаковка'})
    database.createSupplyRequest({productId:'paper',itemName:'Бумага',quantity:10})
    for(let index=0;index<4;index+=1)database.recordCleanerVisit('Николай')
    expect(database.getWorkplaceData().cleaner.paymentDueMinor).toBe(200000)
    database.payCleaner(200000)
    expect(database.getWorkplaceData().cleaner.paymentDueMinor).toBe(0)
    expect(database.pendingEvents().map((x)=>x.eventType)).toEqual(expect.arrayContaining([
      'cash.counted','stock.write_off.requested','point.supply.requested','cleaner.visit.recorded','cleaner.paid'
    ]))
    expect(database.pendingEvents().filter((x)=>x.eventType==='cash.deposited')).toHaveLength(0)
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
