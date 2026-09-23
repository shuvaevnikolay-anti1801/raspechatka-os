import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PosDatabase } from './database'

describe('DEV-172 stage 5 local order issue semantics',()=>{
  it('keeps the first issuedAt when an issued update is replayed',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-order-issued-'))
    const database=new PosDatabase(join(folder,'test.sqlite'))
    try{
      const shift=database.openShift({
        id:'shift-issued',openedAt:'2026-09-23T10:00:00.000Z',cashierName:'Тест',
      })
      database.saveSale({
        id:'sale-issued',clientRequestId:'request-issued',shiftId:shift.id,totalMinor:2000,
        paymentMethod:'cash',fiscalNumber:'FD-ISSUED',createdAt:'2026-09-23T10:01:00.000Z',
        receiptDiscountPercent:0,
        lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
        payments:[{method:'cash',amountMinor:2000}],
      })
      const order=database.createOrderFromSale({
        saleId:'sale-issued',phone:'+7 900 123-45-67',contactMethod:'Telegram',
        comment:'Выдать клиенту',dueAt:'2026-09-23T12:00:00.000Z',
      },'cashier-issued')

      database.updateOrder({id:order.id,status:'ready'},'cashier-issued')
      const issued=database.updateOrder({id:order.id,status:'issued'},'cashier-issued')
      expect(issued.issuedAt).toBeTruthy()

      const replay=database.updateOrder({id:order.id,status:'issued'},'cashier-issued')
      expect(replay.issuedAt).toBe(issued.issuedAt)
      expect(database.listOrders().find((row)=>row.id===order.id)?.issuedAt).toBe(issued.issuedAt)
    }finally{
      database.close()
      rmSync(folder,{recursive:true,force:true})
    }
  })
})