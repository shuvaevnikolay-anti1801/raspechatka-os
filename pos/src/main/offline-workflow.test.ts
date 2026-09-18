import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Order, ReceiptMirror } from '../shared/contracts'
import { normalizeRussianPhone } from '../shared/phone'
import { PosDatabase } from './database'

const folders:string[]=[]
const databases:PosDatabase[]=[]
const createDatabase=()=>{const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-offline-'));folders.push(folder);const database=new PosDatabase(join(folder,'test.sqlite'));databases.push(database);return database}
afterEach(()=>{databases.splice(0).forEach((database)=>database.close());folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))})

describe('offline working state',()=>{
  it('finds a customer beyond the first 50 by name and normalized phone',()=>{
    const database=createDatabase()
    database.replaceCustomers(Array.from({length:80},(_,index)=>({id:`client-${index}`,name:index===71?'Редкий Покупатель':`Клиент ${String(index).padStart(3,'0')}`,phone:index===71?'8 (900) 555-44-33':`+7 901 000 ${String(index).padStart(4,'0')}`,discountPercent:index===71?9:0,isClubMember:index===71?1:0})))
    expect(database.listCustomers('Редкий')[0]).toMatchObject({id:'client-71',discountPercent:9})
    expect(database.listCustomers('+7 900 555-44-33')[0].id).toBe('client-71')
    expect(database.listCustomers('89005554433')[0].id).toBe('client-71')
    expect(normalizeRussianPhone('900 555-44-33')).toBe('+79005554433')
    expect(normalizeRussianPhone('123')).toBe('')
  })

  it('replaces the confirmed employee allowlist and never restores a revoked employee',()=>{
    const database=createDatabase();database.replacePointEmployees([{id:'allowed',name:'Разрешён'},{id:'revoked',name:'Отозван'}])
    database.replacePointEmployees([{id:'allowed',name:'Разрешён'}])
    expect(database.listPointEmployees().map((row)=>row.id)).toEqual(['allowed'])
  })

  it('clears confirmed old-point data without deleting local transactions',()=>{
    const database=createDatabase();database.replacePointEmployees([{id:'old-cashier',name:'Старый кассир'}]);database.replaceCustomers([{id:'old-client',name:'Старый клиент',phone:'+79000000000',discountPercent:10}])
    const shift=database.openShift({id:'shift-local',openedAt:new Date().toISOString(),cashierName:'Кассир'})
    database.saveSale({id:'sale-local',clientRequestId:'request-local',shiftId:shift.id,totalMinor:2000,paymentMethod:'cash',fiscalNumber:'FD-LOCAL',createdAt:new Date().toISOString(),receiptDiscountPercent:0,lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],payments:[{method:'cash',amountMinor:2000}]})
    database.clearConfirmedPointData()
    expect(database.listPointEmployees()).toEqual([]);expect(database.listCustomers('Старый')).toEqual([])
    expect(database.getSale('sale-local').receiptNumber).toBe('FD-LOCAL');expect(database.pendingEvents().map((event)=>event.eventType)).toContain('sale.completed')
  })

  it('upserts point receipt history without duplicates and rejects another point',()=>{
    const database=createDatabase();const receipt:ReceiptMirror={id:'sale-remote',serverId:'SR-1',externalId:'sale-remote',pointId:'point-a',receiptNumber:'FD-1',totalMinor:2500,returnedMinor:0,paymentMethod:'cash',customerName:'Клиент',createdAt:new Date().toISOString(),status:'completed',lines:[{id:0,productId:'paper',name:'Бумага',quantity:1,unitPriceMinor:2500,returnedQuantity:0}],payments:[{method:'cash',amountMinor:2500}]}
    database.replaceReceiptMirror('point-a',[receipt]);database.replaceReceiptMirror('point-a',[receipt])
    expect(database.listSales().filter((row)=>row.id==='sale-remote')).toHaveLength(1);expect(database.getSale('sale-remote').lines[0].name).toBe('Бумага')
    expect(()=>database.replaceReceiptMirror('point-a',[{...receipt,serverId:'SR-2',pointId:'point-b'}])).toThrow(/другой точки/)
  })

  it('upserts server orders onto the local order identity',()=>{
    const database=createDatabase();const now=new Date().toISOString();const order:Order={id:'server-order',orderNumber:'ORD-1',phone:'+79000000000',lines:[],totalMinor:1000,paidMinor:0,paymentStatus:'unpaid',status:'new',createdAt:now}
    database.replaceServerOrders('point-a',[order]);database.replaceServerOrders('point-a',[{...order,status:'ready'}])
    expect(database.listOrders().filter((row)=>row.orderNumber==='ORD-1')).toHaveLength(1);expect(database.listOrders()[0].status).toBe('ready')
  })

  it('keeps a completed local sale and outbox after application restart',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-restart-'));folders.push(folder);const path=join(folder,'pos.sqlite');const first=new PosDatabase(path)
    const shift=first.openShift({id:'shift-restart',openedAt:new Date().toISOString(),cashierName:'Кассир'});first.saveSale({id:'sale-restart',clientRequestId:'request-restart',shiftId:shift.id,totalMinor:2000,paymentMethod:'cash',fiscalNumber:'FD-RESTART',createdAt:new Date().toISOString(),receiptDiscountPercent:0,lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],payments:[{method:'cash',amountMinor:2000}]});first.close()
    const second=new PosDatabase(path);databases.push(second);expect(second.getSale('sale-restart').receiptNumber).toBe('FD-RESTART');expect(second.pendingEvents().map((event)=>event.eventType)).toContain('sale.completed')
  })

  it('keeps commodity printing out of complete-sale and selects cashiers locally',()=>{
    const ipc=readFileSync(new URL('./ipc.ts',import.meta.url),'utf8');const handler=ipc.slice(ipc.indexOf("ipcMain.handle('pos:complete-sale'"),ipc.indexOf("ipcMain.handle('pos:create-return'"));expect(handler).not.toContain('printQueue.printSale');expect(handler).toContain('transactionEngine.completeSale')
    const pairing=readFileSync(new URL('./pairing-ipc.ts',import.meta.url),'utf8');expect(pairing).toContain('CashierAuthSession');expect(pairing).not.toContain('set-active-cashier');expect(pairing).not.toContain('performSync')
  })
})
