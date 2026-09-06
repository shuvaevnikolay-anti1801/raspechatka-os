import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PosDatabase } from './database'

const folders:string[]=[]
afterEach(()=>{folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))})

describe('PosDatabase',()=>{
  it('creates the local catalog and holds a receipt',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-'))
    folders.push(folder)
    const database=new PosDatabase(join(folder,'test.sqlite'))
    expect(database.listProducts().length).toBeGreaterThan(0)
    const held=database.holdReceipt({label:'Тест',lines:[],discountPercent:0})
    expect(database.listHeldReceipts()[0].id).toBe(held.id)
    database.deleteHeldReceipt(held.id)
    expect(database.listHeldReceipts()).toHaveLength(0)
  })

  it('stores split payments, partial returns and cash operations',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-'))
    folders.push(folder)
    const database=new PosDatabase(join(folder,'test.sqlite'))
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

  it('caches OS customer history and updates stock after sale and return',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-'))
    folders.push(folder)
    const database=new PosDatabase(join(folder,'test.sqlite'))
    database.replaceCustomers([{id:'client-1',name:'Иван',phone:'+7 900 111-22-33',discountPercent:7,purchaseCount:3,totalSpentMinor:125000}])
    expect(database.listCustomers('111')[0]).toMatchObject({id:'client-1',purchaseCount:3,totalSpentMinor:125000})
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
})
