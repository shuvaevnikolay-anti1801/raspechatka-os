import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

describe('customer order number',()=>{
  const line={productId:'print',name:'Печать',quantity:1,unitPriceMinor:100}
  it('allocates within active orders and preserves the number on phone edits and server replacement',()=>{
    const folder=mkdtempSync(join(tmpdir(),'pos-order-number-'))
    const database=new PosDatabase(join(folder,'test.sqlite'))
    try{
      const create=()=>database.createUnpaidOrder({phone:'+7 900 123-45-67',lines:[line]})
      const first=create(),second=create()
      expect(first.customerOrderNumber).toBe('4567')
      expect(second.customerOrderNumber).toBe('4567 (1)')
      expect(first.orderNumber).toMatch(/^ORD-\d{8}-[A-F0-9]{6}$/)
      const edited=database.updateOrder({id:first.id,phone:'+7 900 999-99-99'})
      expect(edited.customerOrderNumber).toBe('4567')
      database.replaceServerOrders('point',[{...second,id:'server-order',status:'new'}])
      expect(database.listOrders().find((row)=>row.orderNumber===second.orderNumber)?.customerOrderNumber).toBe('4567 (1)')
      expect(create().customerOrderNumber).toBe('4567 (2)')
    }finally{database.close();rmSync(folder,{recursive:true,force:true})}
  })

  it('backfills legacy rows by creation time and technical id without changing queued payloads',()=>{
    const folder=mkdtempSync(join(tmpdir(),'pos-order-legacy-'))
    const path=join(folder,'test.sqlite')
    const initial=new PosDatabase(path)
    initial.close()
    const sqlite=new DatabaseSync(path)
    for(const [id,created] of [['B','2026-09-02'],['A','2026-09-01']]){
      sqlite.prepare(`INSERT INTO orders (id,order_number,phone,lines_json,total_minor,paid_minor,status,created_at,updated_at)
        VALUES (?,?,?, '[]',100,0,'new',?,?)`).run(id,'ORD-'+id,'+7 900 123-45-67',created,created)
    }
    sqlite.close()
    const database=new PosDatabase(path)
    try{
      const byId=new Map(database.listOrders().map((row)=>[row.id,row]))
      expect(byId.get('A')?.customerOrderNumber).toBe('4567')
      expect(byId.get('B')?.customerOrderNumber).toBe('4567 (1)')
      expect(byId.get('A')?.orderNumber).toBe('ORD-A')
      database.close()
      const reopened=new PosDatabase(path)
      expect(reopened.listOrders().find((row)=>row.id==='A')?.customerOrderNumber).toBe('4567')
      reopened.close()
    }finally{rmSync(folder,{recursive:true,force:true})}
  })
})
