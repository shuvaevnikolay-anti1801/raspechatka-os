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
})
