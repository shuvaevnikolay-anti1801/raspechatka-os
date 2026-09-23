import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { PosDatabase } from './database'
import type { CreateUnpaidOrderRequest, StockWriteOffRequest, SupplyRequestInput, UpdateOrderRequest } from '../shared/contracts'

const folders:string[]=[]
const databases:PosDatabase[]=[]
const createDatabase=()=>{
  const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-'))
  folders.push(folder)
  const database=new PosDatabase(join(folder,'test.sqlite'))
  databases.push(database)
  return database
}
const createDatabaseFile=()=>{
  const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-'))
  folders.push(folder)
  return join(folder,'test.sqlite')
}
const openTrackedDatabase=(filePath:string)=>{
  const database=new PosDatabase(filePath)
  databases.push(database)
  return database
}
const createLegacyCashDatabase=(setup:(legacy:DatabaseSync)=>void)=>{
  const filePath=createDatabaseFile()
  const legacy=new DatabaseSync(filePath)
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE shifts (
      id TEXT PRIMARY KEY,opened_at TEXT NOT NULL,closed_at TEXT,cashier_name TEXT NOT NULL
    );
    CREATE TABLE cash_counts (
      id TEXT PRIMARY KEY,shift_id TEXT NOT NULL,count_type TEXT NOT NULL,lines_json TEXT NOT NULL,
      total_minor INTEGER NOT NULL,expected_minor INTEGER NOT NULL,difference_minor INTEGER NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY (shift_id) REFERENCES shifts(id)
    );
    CREATE TABLE cash_operations (
      id TEXT PRIMARY KEY,shift_id TEXT NOT NULL,operation_type TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY (shift_id) REFERENCES shifts(id)
    );
  `)
  setup(legacy)
  legacy.close()
  return {filePath,database:openTrackedDatabase(filePath)}
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

  it('round-trips contact method through local storage and both order events',()=>{
    const database=createDatabase()
    const order=database.createUnpaidOrder({
      phone:'+7 900 123-45-67',
      contactMethod:' Telegram @client ',
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
      comment:'Связаться перед готовностью'
    },'cashier-contact')
    expect(order.contactMethod).toBe('Telegram @client')
    expect(database.listOrders().find((row)=>row.id===order.id)?.contactMethod).toBe('Telegram @client')

    const updated=database.updateOrder({id:order.id,contactMethod:' WhatsApp '},'cashier-contact')
    expect(updated.contactMethod).toBe('WhatsApp')
    expect(database.listOrders().find((row)=>row.id===order.id)?.contactMethod).toBe('WhatsApp')

    const events=database.pendingEvents().filter((event)=>event.eventType.startsWith('order.'))
    expect(events).toHaveLength(2)
    expect(events[0].payload).toEqual(expect.objectContaining({contactMethod:'Telegram @client',cashierId:'cashier-contact'}))
    expect(events[1].payload).toEqual(expect.objectContaining({contactMethod:'WhatsApp',cashierId:'cashier-contact'}))
  })

  it('adds contact_method to legacy order storage idempotently and reads old rows as null',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-legacy-order-'))
    folders.push(folder)
    const filePath=join(folder,'test.sqlite')
    const legacy=new DatabaseSync(filePath)
    legacy.exec(`CREATE TABLE orders (
      id TEXT PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, phone TEXT NOT NULL,
      customer_id TEXT, customer_name TEXT, lines_json TEXT NOT NULL,
      total_minor INTEGER NOT NULL, paid_minor INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new', comment TEXT, due_at TEXT,
      source_sale_id TEXT, fiscal_number TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    legacy.prepare(`INSERT INTO orders
      (id,order_number,phone,lines_json,total_minor,paid_minor,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
        'legacy-order','ORD-LEGACY','+7 900 000-00-01','[]',0,0,'new','2026-09-01T10:00:00.000Z','2026-09-01T10:00:00.000Z'
      )
    legacy.close()

    const migrated=new PosDatabase(filePath)
    databases.push(migrated)
    expect(migrated.listOrders().find((row)=>row.id==='legacy-order')).toMatchObject({contactMethod:null})
    migrated.close()
    databases.splice(databases.indexOf(migrated),1)

    const reopened=new PosDatabase(filePath)
    databases.push(reopened)
    expect(reopened.listOrders().find((row)=>row.id==='legacy-order')).toMatchObject({contactMethod:null})
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

  it('persists authenticated cashier evidence on closed-shift order events',()=>{
    const database=createDatabase()
    database.openShift({
      id:'shift-closed-order',openedAt:'2026-09-06T10:00:00.000Z',
      cashierId:'cashier-from-shift',cashierName:'Тест'
    })
    database.closeShift()
    const order=database.createUnpaidOrder({
      phone:'+7 900 000-00-02',
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
      comment:'После закрытия смены',
      cashierId:'cashier-from-renderer'
    } as CreateUnpaidOrderRequest & {cashierId:string},'cashier-authenticated')
    database.updateOrder({
      id:order.id,status:'ready',cashierId:'cashier-from-renderer'
    } as UpdateOrderRequest & {cashierId:string},'cashier-authenticated')

    const orderEvents=database.pendingEvents().filter((event)=>event.eventType.startsWith('order.'))
    expect(orderEvents).toHaveLength(2)
    expect(orderEvents.map((event)=>event.payload)).toEqual([
      expect.objectContaining({id:order.id,cashierId:'cashier-authenticated'}),
      expect.objectContaining({id:order.id,status:'ready',cashierId:'cashier-authenticated'})
    ])
  })

  it('keeps legacy orders without lifecycle timestamps readable',()=>{
    const database=createDatabase()
    const legacy=database.createUnpaidOrder({
      phone:'+7 900 000-00-01',
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}]
    })
    expect(database.listOrders().find((order)=>order.id===legacy.id)).toMatchObject({
      status:'new',contactMethod:null,readyAt:null,issuedAt:null
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

  it('groups actual payment parts by method while retaining the legacy summary fields',()=>{
    const database=createDatabase()
    const shift=database.openShift({id:'payment-breakdown-shift',openedAt:'2026-09-06T10:00:00.000Z',cashierName:'Тест'})
    database.saveSale({
      id:'payment-breakdown-sale',clientRequestId:'payment-breakdown-request',shiftId:shift.id,
      totalMinor:10000,paymentMethod:'mixed',fiscalNumber:'PAYMENT-BREAKDOWN',
      createdAt:'2026-09-06T10:01:00.000Z',receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:10000}],
      payments:[{method:'cash',amountMinor:1000},{method:'card',amountMinor:2000},
        {method:'qr',amountMinor:3000},{method:'remote_payment',amountMinor:4000}],
    })
    database.saveSale({
      id:'payment-breakdown-card',clientRequestId:'payment-breakdown-card-request',shiftId:shift.id,
      totalMinor:500,paymentMethod:'card',fiscalNumber:'PAYMENT-CARD',
      createdAt:'2026-09-06T10:02:00.000Z',receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:500}],
      payments:[{method:'card',amountMinor:500}],
    })
    const summary=database.getShiftSummary()
    expect(summary.paymentBreakdown).toEqual([
      {method:'card',amountMinor:2500},{method:'cash',amountMinor:1000},
      {method:'qr',amountMinor:3000},{method:'remote_payment',amountMinor:4000},
    ])
    expect(summary).toMatchObject({cashMinor:1000,cardMinor:2500,qrMinor:3000,remotePaymentMinor:4000})
    expect(summary.paymentBreakdown?.some(({method})=>method==='mixed')).toBe(false)
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
    database.reportStockWriteOff({
      productId:'paper-hidden',quantity:1,reason:'Брак',comment:'Замята упаковка',
      cashierId:'FORGED-RENDERER'
    } as StockWriteOffRequest & {cashierId:string},'EMP-1')
    database.createSupplyRequest({
      productId:'paper-hidden',itemName:'Клиент не должен переименовать',comment:'Нужен запас бумаги',
      quantity:999,cashierId:'FORGED-RENDERER'
    } as SupplyRequestInput & {quantity:number;cashierId:string},'EMP-1')
    database.createStockReceipt({purchaseOrderId:'PO-1',lines:[{purchaseOrderItemId:'POI-1',quantity:2}]},'EMP-1')
    for(let index=0;index<4;index+=1)database.recordCleanerVisit('Николай')
    expect(database.getWorkplaceData().cleaner.paymentDueMinor).toBe(200000)
    expect(database.getWorkplaceData().deliveries[0].items[0].remainingQuantity).toBe(4)
    database.payCleaner(200000)
    expect(database.getWorkplaceData().cleaner.paymentDueMinor).toBe(0)

    const events=database.pendingEvents()
    expect(events.map((x)=>x.eventType)).toEqual(expect.arrayContaining([
      'cash.counted','stock.write_off.requested','point.supply.requested','stock.receipt.requested','cleaner.visit.recorded','cleaner.paid'
    ]))
    const writeOff=events.find((x)=>x.eventType==='stock.write_off.requested')?.payload as Record<string,unknown>
    const need=events.find((x)=>x.eventType==='point.supply.requested')?.payload as Record<string,unknown>
    const receipt=events.find((x)=>x.eventType==='stock.receipt.requested')?.payload as Record<string,unknown>
    expect(writeOff).toMatchObject({
      cashierId:'EMP-1',productId:'paper-hidden',reason:'Брак',comment:'Замята упаковка'
    })
    expect(writeOff.cashierId).not.toBe('FORGED-RENDERER')
    expect(need).toEqual({
      cashierId:'EMP-1',productId:'paper-hidden',itemName:'Бумага служебная',comment:'Нужен запас бумаги'
    })
    expect(need).not.toHaveProperty('quantity')
    expect(receipt).toEqual({
      cashierId:'EMP-1',
      purchaseOrderId:'PO-1',
      lines:[{purchaseOrderItemId:'POI-1',quantity:2}],
    })
    expect(JSON.stringify(receipt)).not.toContain('rate')
    expect(receipt.cashierId).not.toBe('SHIFT-EMP')
    expect(database.pendingEvents().filter((x)=>x.eventType==='cash.deposited')).toHaveLength(0)
  })

  it('rejects unsafe warehouse request input before it reaches the outbox',()=>{
    const database=createDatabase()
    database.setWorkplaceData({
      schedule:[],
      scheduleMonth:{month:'2026-09',days:30,employees:[],entries:[]},
      myUpcomingShifts:[],
      operationalCatalog:[{
        id:'paper-hidden',name:'Бумага служебная',itemCode:'PAPER-HIDDEN',itemType:'Product',uom:'пачка',
        trackInventory:true,stock:5,storageAddress:'Шкаф 3'
      }],
      deliveries:[],supplyRequests:[],
      cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},
      orders:[],
    })

    expect(()=>database.reportStockWriteOff({
      productId:'paper-hidden',quantity:1,reason:'Другое',comment:'Комментарий'
    } as unknown as StockWriteOffRequest,'EMP-1')).toThrow('Недопустимая причина списания')
    expect(()=>database.reportStockWriteOff({
      productId:'paper-hidden',quantity:1,reason:'Брак',comment:'   '
    },'EMP-1')).toThrow('Комментарий обязателен')
    expect(()=>database.createSupplyRequest({
      productId:'paper-hidden',itemName:'Бумага',comment:'   '
    },'EMP-1')).toThrow('Комментарий обязателен')
    expect(database.pendingEvents()).toHaveLength(0)
  })

  it('keeps a partially received purchase order unchanged until canonical sync',()=>{
    const database=createDatabase()
    database.setWorkplaceData({
      schedule:[],
      scheduleMonth:{month:'2026-09',days:30,employees:[],entries:[]},
      myUpcomingShifts:[],
      operationalCatalog:[],
      deliveries:[{
        id:'PO-PART',supplier:'Поставщик',status:'Ожидается',items:[{
          purchaseOrderItemId:'POI-PART',itemId:'item',itemName:'Товар',itemCode:'ITEM',
          uom:'шт',orderedQuantity:5,receivedQuantity:1,remainingQuantity:4,
        }],
      }],
      supplyRequests:[],
      cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},
      orders:[],
    })
    database.createStockReceipt({
      purchaseOrderId:'PO-PART',
      lines:[{purchaseOrderItemId:'POI-PART',quantity:2}],
    },'EMP-1')
    expect(database.getWorkplaceData().deliveries).toEqual([expect.objectContaining({
      id:'PO-PART',
      status:'Ожидается',
      items:[expect.objectContaining({purchaseOrderItemId:'POI-PART',receivedQuantity:1,remainingQuantity:4})],
    })])
    expect(database.pendingEvents().filter((event)=>event.eventType==='stock.receipt.requested')).toHaveLength(1)
  })

  it('keeps a fully requested receipt visible until canonical sync confirms it',()=>{
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
    expect(database.getWorkplaceData().deliveries).toEqual([expect.objectContaining({
      id:'PO-FULL',
      status:'Ожидается',
      items:[expect.objectContaining({purchaseOrderItemId:'POI-FULL',receivedQuantity:0,remainingQuantity:2})],
    })])
    expect(database.pendingEvents().filter((event)=>event.eventType==='stock.receipt.requested')).toHaveLength(1)
  })

  describe('DEV-173 durable cash drawer v1',()=>{
    const bootstrap=(legacy:DatabaseSync,pointId='point-1',workplaceId='register-1')=>{
      legacy.prepare("INSERT INTO app_state (key,value) VALUES ('bootstrap',?)")
        .run(JSON.stringify({pointId,workplaceId}))
    }

    it('creates a verified zero baseline only for a fresh physical register context',()=>{
      const database=createDatabase()
      expect(database.getCashDrawerState('point-fresh','register-fresh')).toMatchObject({
        schemaVersion:1,pointId:'point-fresh',workplaceId:'register-fresh',
        baselineMinor:0,baselineVerified:true,openingCountPending:false,baselineSource:'fresh_install',
      })
    })

    it('migrates the latest closed-shift closing count as the trusted baseline',()=>{
      const {database}=createLegacyCashDatabase((legacy)=>{
        bootstrap(legacy)
        legacy.exec(`
          INSERT INTO shifts (id,opened_at,closed_at,cashier_name)
          VALUES ('closed','2026-09-01T08:00:00.000Z','2026-09-01T18:00:00.000Z','A');
          INSERT INTO cash_counts (id,shift_id,count_type,lines_json,total_minor,expected_minor,difference_minor,created_at)
          VALUES ('closing-count','closed','closing','[]',125000,124000,1000,'2026-09-01T17:59:00.000Z');
        `)
      })
      expect(database.getCashDrawerState('point-1','register-1')).toMatchObject({
        schemaVersion:1,baselineMinor:125000,baselineVerified:true,openingCountPending:false,
        baselineSource:'legacy_closing_count',baselineSourceId:'closing-count',
        baselineAt:'2026-09-01T17:59:00.000Z',
      })
    })

    it('migrates an active-shift control count without replaying shift cash effects',()=>{
      const {database}=createLegacyCashDatabase((legacy)=>{
        bootstrap(legacy)
        legacy.exec(`
          INSERT INTO shifts (id,opened_at,closed_at,cashier_name)
          VALUES ('active','2026-09-02T08:00:00.000Z',NULL,'A');
          INSERT INTO cash_counts (id,shift_id,count_type,lines_json,total_minor,expected_minor,difference_minor,created_at)
          VALUES ('control-count','active','control','[]',87000,86000,1000,'2026-09-02T12:00:00.000Z');
          INSERT INTO cash_operations (id,shift_id,operation_type,amount_minor,reason,created_at)
          VALUES ('deposit-after','active','deposit',5000,'test','2026-09-02T13:00:00.000Z');
        `)
      })
      expect(database.getCashDrawerState('point-1','register-1')).toMatchObject({
        baselineMinor:87000,baselineVerified:true,openingCountPending:false,
        baselineSource:'legacy_control_count',baselineSourceId:'control-count',
      })
      expect(database.getShiftSummary()).toMatchObject({depositsMinor:5000,expectedCashMinor:5000})
    })

    it('keeps ambiguous legacy cash history explicitly unverified instead of writing zero',()=>{
      const {database}=createLegacyCashDatabase((legacy)=>{
        bootstrap(legacy)
        legacy.exec(`
          INSERT INTO shifts (id,opened_at,closed_at,cashier_name)
          VALUES ('legacy','2026-09-03T08:00:00.000Z','2026-09-03T18:00:00.000Z','A');
          INSERT INTO cash_operations (id,shift_id,operation_type,amount_minor,reason,created_at)
          VALUES ('legacy-deposit','legacy','deposit',15000,'test','2026-09-03T10:00:00.000Z');
        `)
      })
      expect(database.getCashDrawerState('point-1','register-1')).toMatchObject({
        baselineMinor:null,baselineVerified:false,openingCountPending:true,baselineSource:'legacy_unverified',
      })
    })

    it('persists trusted drawer state across restart and only accepts a stored cash count as baseline evidence',()=>{
      const filePath=createDatabaseFile()
      let database=openTrackedDatabase(filePath)
      const shift=database.openShift({id:'restart-shift',openedAt:'2026-09-04T08:00:00.000Z',cashierName:'A'})
      const count=database.saveCashCount('control',[{denominationMinor:1000,quantity:42}])
      const updated=database.updateCashDrawerBaselineFromCount('point-restart','register-restart',count.id)
      expect(updated).toMatchObject({baselineMinor:42000,baselineVerified:true,openingCountPending:false,baselineSource:'cash_count'})
      expect(()=>database.updateCashDrawerBaselineFromCount('point-restart','register-restart','missing-count')).toThrow(/не найден/)
      database.close()
      databases.splice(databases.indexOf(database),1)
      database=openTrackedDatabase(filePath)
      expect(database.getCashDrawerState('point-restart','register-restart')).toMatchObject({
        baselineMinor:42000,baselineVerified:true,baselineSourceId:count.id,
      })
      expect(database.currentShift()?.id).toBe(shift.id)
    })

    it('isolates durable state by point and workplace rather than cashier or shift',()=>{
      const database=createDatabase()
      expect(database.getCashDrawerState('point-a','register-a').baselineMinor).toBe(0)
      expect(database.getCashDrawerState('point-a','register-b').baselineMinor).toBe(0)
      database.openShift({id:'isolation-shift',openedAt:'2026-09-05T08:00:00.000Z',cashierId:'cashier-a',cashierName:'A'})
      const count=database.saveCashCount('control',[{denominationMinor:5000,quantity:3}])
      database.updateCashDrawerBaselineFromCount('point-a','register-a',count.id)
      expect(database.getCashDrawerState('point-a','register-a').baselineMinor).toBe(15000)
      expect(database.getCashDrawerState('point-a','register-b').baselineMinor).toBe(0)
      expect(database.getCashDrawerState('point-b','register-a').baselineMinor).toBe(0)
    })
  })

  describe('DEV-173 drawer shift state machine',()=>{
    const bindDrawer=(database:PosDatabase,pointId='point-stage2',workplaceId='register-stage2')=>{
      database.setState('bootstrap',JSON.stringify({pointId,workplaceId}))
      return {pointId,workplaceId}
    }

    it('freezes the opening expected baseline and allows opening count to be deferred',()=>{
      const database=createDatabase()
      const {pointId,workplaceId}=bindDrawer(database)
      database.getCashDrawerState(pointId,workplaceId)
      database.openShift({id:'deferred-opening',openedAt:'2026-09-08T08:00:00.000Z',cashierId:'A',cashierName:'A'})
      expect(database.currentShift()).toMatchObject({
        id:'deferred-opening',openingExpectedMinor:0,openingExpectedVerified:true,openingCountPending:true,
      })
      expect(database.getShiftSummary()).toMatchObject({
        expectedCashMinor:0,expectedCashVerified:true,openingCountPending:true,
      })

      database.addCashOperation('deposit',5000,'размен')
      const opening=database.saveCashCount('opening',[{denominationMinor:1000,quantity:4}])
      expect(opening).toMatchObject({
        totalMinor:4000,expectedMinor:0,expectedVerified:true,differenceMinor:4000,
      })
      expect(database.getCashDrawerState(pointId,workplaceId).openingCountPending).toBe(false)
      expect(database.getShiftSummary().expectedCashMinor).toBe(5000)
    })

    it('blocks work-shift close until a current closing count exists',()=>{
      const database=createDatabase()
      bindDrawer(database)
      database.openShift({id:'must-close-count',openedAt:'2026-09-09T08:00:00.000Z',cashierId:'A',cashierName:'A'})
      expect(()=>database.assertShiftReadyToClose()).toThrow(/закрывающий пересчёт/)
      expect(()=>database.closeShift()).toThrow(/закрывающий пересчёт/)
      database.saveCashCount('closing',[])
      database.addCashOperation('deposit',1000,'after count')
      expect(()=>database.assertShiftReadyToClose()).toThrow(/движение наличных изменилось/)
      expect(()=>database.closeShift()).toThrow(/движение наличных изменилось/)
      const closing=database.saveCashCount('closing',[{denominationMinor:1000,quantity:1}])
      expect(closing).toMatchObject({expectedMinor:1000,totalMinor:1000,differenceMinor:0})
      expect(()=>database.closeShift()).not.toThrow()
    })

    it('hands the closing physical balance from cashier A to cashier B and marks B opening pending',()=>{
      const database=createDatabase()
      const {pointId,workplaceId}=bindDrawer(database,'point-handoff','register-handoff')
      database.openShift({id:'shift-a',openedAt:'2026-09-10T08:00:00.000Z',cashierId:'A',cashierName:'A'})
      database.saveCashCount('opening',[])
      database.addCashOperation('deposit',12000,'float')
      const closing=database.saveCashCount('closing',[{denominationMinor:1000,quantity:11}])
      expect(closing).toMatchObject({expectedMinor:12000,totalMinor:11000,differenceMinor:-1000})
      database.closeShift()
      expect(database.getCashDrawerState(pointId,workplaceId)).toMatchObject({
        baselineMinor:11000,baselineVerified:true,openingCountPending:false,baselineSourceId:closing.id,
      })

      const next=database.openShift({id:'shift-b',openedAt:'2026-09-10T14:00:00.000Z',cashierId:'B',cashierName:'B'})
      expect(next).toMatchObject({
        cashierId:'B',openingExpectedMinor:11000,openingExpectedVerified:true,openingCountPending:true,
      })
      const opening=database.saveCashCount('opening',[{denominationMinor:1000,quantity:10}])
      expect(opening).toMatchObject({expectedMinor:11000,totalMinor:10000,differenceMinor:-1000})
      expect(database.getShiftSummary().expectedCashMinor).toBe(11000)
    })

    it('carries cashier A closing count through restart and cashier B hand-off',()=>{
      const filePath=createDatabaseFile()
      let database=openTrackedDatabase(filePath)
      const {pointId,workplaceId}=bindDrawer(database,'point-handoff-restart','register-handoff-restart')
      database.openShift({id:'handoff-a',openedAt:'2026-09-14T08:00:00.000Z',cashierId:'A',cashierName:'A'})
      database.saveCashCount('opening',[])
      database.addCashOperation('deposit',15000,'float')
      const closing=database.saveCashCount('closing',[{denominationMinor:1000,quantity:14}])
      expect(closing).toMatchObject({expectedMinor:15000,totalMinor:14000,differenceMinor:-1000})
      database.closeShift()
      database.close()
      databases.splice(databases.indexOf(database),1)

      database=openTrackedDatabase(filePath)
      expect(database.currentShift()).toBeNull()
      expect(database.getCashDrawerState(pointId,workplaceId)).toMatchObject({
        baselineMinor:14000,baselineVerified:true,baselineSourceId:closing.id,
      })
      const next=database.openShift({id:'handoff-b',openedAt:'2026-09-14T14:00:00.000Z',cashierId:'B',cashierName:'B'})
      expect(next).toMatchObject({cashierId:'B',openingExpectedMinor:14000,openingCountPending:true})
      expect(database.saveCashCount('opening',[{denominationMinor:1000,quantity:14}]))
        .toMatchObject({expectedMinor:14000,totalMinor:14000,differenceMinor:0})
    })

    it('keeps the saved control-count delta immutable after later cash movement and restart',()=>{
      const filePath=createDatabaseFile()
      let database=openTrackedDatabase(filePath)
      bindDrawer(database,'point-count-snapshot','register-count-snapshot')
      database.openShift({id:'count-snapshot',openedAt:'2026-09-15T08:00:00.000Z',cashierId:'A',cashierName:'A'})
      database.saveCashCount('opening',[])
      database.addCashOperation('deposit',5000,'float')
      const count=database.saveCashCount('control',[{denominationMinor:1000,quantity:4}])
      expect(count).toMatchObject({expectedMinor:5000,totalMinor:4000,differenceMinor:-1000})
      database.addCashOperation('withdrawal',2000,'later withdrawal')
      expect(database.getShiftSummary().expectedCashMinor).toBe(3000)
      database.close()
      databases.splice(databases.indexOf(database),1)

      database=openTrackedDatabase(filePath)
      expect(database.getLastCashCount()).toMatchObject({
        id:count.id,expectedMinor:5000,totalMinor:4000,differenceMinor:-1000,
      })
      expect(database.getShiftSummary().expectedCashMinor).toBe(3000)
    })

    it('counts sale return deposit and withdrawal exactly once from the frozen baseline',()=>{
      const database=createDatabase()
      bindDrawer(database,'point-accounting','register-accounting')
      const shift=database.openShift({id:'accounting-shift',openedAt:'2026-09-11T08:00:00.000Z',cashierId:'A',cashierName:'A'})
      database.saveCashCount('opening',[])
      database.saveSale({
        id:'drawer-sale',clientRequestId:'drawer-sale-request',shiftId:shift.id,totalMinor:10000,
        paymentMethod:'cash',fiscalNumber:'DRAWER-SALE',createdAt:'2026-09-11T09:00:00.000Z',receiptDiscountPercent:0,
        lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:10000}],
        payments:[{method:'cash',amountMinor:10000}],
      })
      const sale=database.getSale('drawer-sale')
      database.saveReturn({
        id:'drawer-return',clientRequestId:'drawer-return-request',saleId:sale.id,shiftId:shift.id,
        totalMinor:2000,fiscalNumber:'DRAWER-RETURN',createdAt:'2026-09-11T10:00:00.000Z',
        lines:[{saleItemId:sale.lines[0].id,quantity:0.2,lineTotalMinor:2000}],
        payments:[{method:'cash',amountMinor:2000}],
      })
      database.addCashOperation('deposit',3000,'deposit')
      database.addCashOperation('withdrawal',1000,'withdrawal')
      expect(database.getShiftSummary()).toMatchObject({
        cashMinor:10000,returnsMinor:2000,depositsMinor:3000,withdrawalsMinor:1000,
        expectedCashMinor:10000,expectedCashVerified:true,
      })
      const control=database.saveCashCount('control',[{denominationMinor:1000,quantity:9}])
      expect(control).toMatchObject({expectedMinor:10000,totalMinor:9000,differenceMinor:-1000})
      expect(database.getShiftSummary().expectedCashMinor).toBe(10000)
    })

    it('absorbs pre-count cash movement when an unverified legacy drawer becomes trusted',()=>{
      const {database}=createLegacyCashDatabase((legacy)=>{
        legacy.prepare("INSERT INTO app_state (key,value) VALUES ('bootstrap',?)")
          .run(JSON.stringify({pointId:'point-legacy-pending',workplaceId:'register-legacy-pending'}))
        legacy.exec(`
          INSERT INTO shifts (id,opened_at,closed_at,cashier_name)
          VALUES ('legacy-closed','2026-09-01T08:00:00.000Z','2026-09-01T18:00:00.000Z','Legacy');
          INSERT INTO cash_operations (id,shift_id,operation_type,amount_minor,reason,created_at)
          VALUES ('legacy-unknown','legacy-closed','deposit',1000,'legacy','2026-09-01T09:00:00.000Z');
        `)
      })
      expect(database.getCashDrawerState('point-legacy-pending','register-legacy-pending')).toMatchObject({
        baselineMinor:null,baselineVerified:false,openingCountPending:true,
      })
      database.openShift({id:'trusted-later',openedAt:'2026-09-13T08:00:00.000Z',cashierId:'A',cashierName:'A'})
      database.addCashOperation('deposit',3000,'before opening count')
      const opening=database.saveCashCount('opening',[{denominationMinor:1000,quantity:4}])
      expect(opening).toMatchObject({expectedMinor:0,expectedVerified:false,totalMinor:4000,differenceMinor:4000})
      expect(database.currentShift()).toMatchObject({
        openingExpectedMinor:4000,openingExpectedVerified:true,openingCountPending:false,
      })
      expect(database.getShiftSummary().expectedCashMinor).toBe(4000)
    })

    it('preserves opening pending and frozen baseline across restart',()=>{
      const filePath=createDatabaseFile()
      let database=openTrackedDatabase(filePath)
      const {pointId,workplaceId}=bindDrawer(database,'point-restart-pending','register-restart-pending')
      database.openShift({id:'restart-pending',openedAt:'2026-09-12T08:00:00.000Z',cashierId:'A',cashierName:'A'})
      database.close()
      databases.splice(databases.indexOf(database),1)

      database=openTrackedDatabase(filePath)
      expect(database.currentShift()).toMatchObject({
        id:'restart-pending',openingExpectedMinor:0,openingExpectedVerified:true,openingCountPending:true,
      })
      expect(database.getCashDrawerState(pointId,workplaceId).openingCountPending).toBe(true)
      const opening=database.saveCashCount('opening',[{denominationMinor:1000,quantity:2}])
      expect(opening).toMatchObject({expectedMinor:0,totalMinor:2000,differenceMinor:2000})
      expect(database.getCashDrawerState(pointId,workplaceId).openingCountPending).toBe(false)
    })
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
  it('normalizes an old cached workplace snapshot into the two-month schedule shape',()=>{
    const database=createDatabase()
    database.setState('workplace_data',JSON.stringify({
      schedule:[],
      scheduleMonth:{
        month:'2026-12',days:31,
        employees:[{id:'EMP-1',name:'Анна'}],
        entries:[{
          id:'WS-1',date:'2026-12-31',employeeId:'EMP-1',employeeName:'Анна',
          shiftTemplate:'SHIFT-U',shiftCode:'U',shiftName:'Утро',startTime:'09:00:00',endTime:'15:00:00',plannedHours:6
        }]
      },
      myUpcomingShifts:[],
      operationalCatalog:[],
      deliveries:[],
      supplyRequests:[],
      cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},
      orders:[],
    }))
    const data=database.getWorkplaceData()
    expect(data.scheduleCurrentMonth).toEqual(data.scheduleMonth)
    expect(data.scheduleCurrentMonth.month).toBe('2026-12')
    expect(data.scheduleNextMonth).toEqual({month:'2027-01',days:31,employees:[],entries:[]})
  })

})
