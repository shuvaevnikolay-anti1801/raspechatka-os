import { describe, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>({
  deferred:{} as {resolve?: (value:any)=>void},
  loadBootstrap:vi.fn(()=>new Promise((resolve)=>{mocks.deferred.resolve=resolve})),
  pushEvents:vi.fn(async()=>[]),
}))
vi.mock('./frappe',()=>({loadBootstrap:mocks.loadBootstrap,pushEvents:mocks.pushEvents}))

import { performSync } from './sync'

describe('performSync single flight',()=>{
  it('coalesces a manual and background request for the same database',async()=>{
    const state=new Map<string,string>()
    const database:any={
      getState:(key:string)=>state.get(key),setState:(key:string,value:string)=>state.set(key,value),
      replaceProducts:vi.fn(),replaceCustomers:vi.fn(),replacePointEmployees:vi.fn(),
      replaceReceiptMirror:vi.fn(),replaceServerOrders:vi.fn(),setWorkplaceData:vi.fn(),
      listPointEmployees:()=>[],pendingSyncCount:()=>0,currentShift:()=>null,pendingEvents:()=>[],markEventsSent:vi.fn(),
    }
    const connectionStore:any={load:()=>({serverUrl:'https://example.test',deviceId:'dev',token:'token'})}
    const first=performSync(database,connectionStore,'cashier')
    const second=performSync(database,connectionStore,'cashier')
    expect(second).toBe(first)
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(1)
    mocks.deferred.resolve?.({
      products:[],customers:[],employees:[],receiptMirror:[],retentionDays:60,
      point:{id:'point',name:'Point'},workplace:{id:'workplace',name:'POS'},
      workplaceData:{orders:[{
        id:'ORDER-1',orderNumber:'ORD-1',phone:'+79001234567',lines:[],totalMinor:2000,paidMinor:2000,
        paymentStatus:'paid',status:'ready',createdAt:'2026-09-20T09:00:00.000Z',dueAt:'2026-09-20T10:00:00.000Z',
        readyAt:'2026-09-20T09:45:00.000Z',issuedAt:undefined,sourceSaleId:'SALE-1',fiscalNumber:'777'
      }]},rules:{allowDiscounts:true,maxDiscountPercent:20},
    })
    await expect(first).resolves.toMatchObject({online:true,pendingSync:0})
    expect(database.replaceServerOrders).toHaveBeenCalledWith(
      'point',
      [expect.objectContaining({id:'ORDER-1',readyAt:'2026-09-20T09:45:00.000Z',sourceSaleId:'SALE-1'})],
      60,
    )
    expect(mocks.pushEvents).not.toHaveBeenCalled()
  })
})
