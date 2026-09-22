import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>({
  loadBootstrap:vi.fn(),
  pushEvents:vi.fn(),
}))
vi.mock('./frappe',()=>({loadBootstrap:mocks.loadBootstrap,pushEvents:mocks.pushEvents}))

import { performSync } from './sync'

const connectionStore:any={load:()=>({serverUrl:'https://example.test',deviceId:'dev',token:'token'})}
const orderEvent={id:'EVENT-ORDER-1',eventType:'order.created',payload:{orderNumber:'ORD-1'},createdAt:'2026-09-20T09:00:00.000Z'}
const canonicalOrder={
  id:'ORDER-1',orderNumber:'ORD-1',phone:'+79001234567',lines:[],totalMinor:2000,paidMinor:2000,
  paymentStatus:'paid',status:'ready',createdAt:'2026-09-20T09:00:00.000Z',
  readyAt:'2026-09-20T09:45:00.000Z',sourceSaleId:'SALE-1',fiscalNumber:'777'
}
const bootstrap=(orders:any[]=[])=>({
  products:[],customers:[],employees:[],receiptMirror:[],retentionDays:60,
  point:{id:'point',name:'Point'},workplace:{id:'workplace',name:'POS'},
  workplaceData:{
    schedule:[],scheduleMonth:{month:'2026-09',days:30,employees:[],entries:[]},
    myUpcomingShifts:[],orders,
  },
  upsellRules:[],rules:{allowDiscounts:true,maxDiscountPercent:20},
})
const createDatabase=(initialEvents:any[]=[])=>{
  const state=new Map<string,string>()
  let pending=[...initialEvents]
  const database:any={
    getState:(key:string)=>state.get(key),
    setState:vi.fn((key:string,value:string)=>state.set(key,value)),
    replaceProducts:vi.fn(),replaceCustomers:vi.fn(),replacePointEmployees:vi.fn(),
    replaceReceiptMirror:vi.fn(),replaceServerOrders:vi.fn(),setWorkplaceData:vi.fn(),
    listPointEmployees:()=>[],currentShift:()=>null,getUpsellCursor:()=>0,
    pendingSyncCount:()=>pending.length,
    pendingEvents:vi.fn(()=>[...pending]),
    markEventsSent:vi.fn((ids:string[])=>{pending=pending.filter((event)=>!ids.includes(event.id))}),
  }
  return database
}

beforeEach(()=>{
  mocks.loadBootstrap.mockReset()
  mocks.pushEvents.mockReset()
})

describe('performSync',()=>{
  it('coalesces a manual and background request for the same database',async()=>{
    let resolveBootstrap:(value:any)=>void=()=>undefined
    mocks.loadBootstrap.mockImplementationOnce(()=>new Promise((resolve)=>{resolveBootstrap=resolve}))
    mocks.pushEvents.mockResolvedValue([])
    const database=createDatabase()
    const first=performSync(database,connectionStore,'cashier')
    const second=performSync(database,connectionStore,'cashier')
    expect(second).toBe(first)
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(1)
    resolveBootstrap(bootstrap())
    await expect(first).resolves.toMatchObject({online:true,pendingSync:0,documentQueueSynced:true})
    expect(mocks.pushEvents).not.toHaveBeenCalled()
  })

  it('refreshes canonical orders after accepted events in the same cycle',async()=>{
    const database=createDatabase([orderEvent])
    mocks.loadBootstrap
      .mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(bootstrap([canonicalOrder]))
    mocks.pushEvents.mockResolvedValueOnce([orderEvent.id])

    const result=await performSync(database,connectionStore,'cashier')

    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(2)
    expect(mocks.loadBootstrap.mock.invocationCallOrder[0]).toBeLessThan(mocks.pushEvents.mock.invocationCallOrder[0])
    expect(mocks.pushEvents.mock.invocationCallOrder[0]).toBeLessThan(mocks.loadBootstrap.mock.invocationCallOrder[1])
    expect(database.replaceServerOrders).toHaveBeenLastCalledWith(
      'point',[expect.objectContaining({id:'ORDER-1',status:'ready'})],60,
    )
    expect(result).toMatchObject({online:true,pendingSync:0,documentQueueSynced:true})
  })

  it('keeps failed outbox events pending and surfaces the queue error',async()=>{
    const database=createDatabase([orderEvent])
    mocks.loadBootstrap.mockResolvedValueOnce(bootstrap())
    mocks.pushEvents.mockRejectedValueOnce(new Error('Сервер отклонил очередь'))

    const result=await performSync(database,connectionStore,'cashier')

    expect(database.markEventsSent).not.toHaveBeenCalled()
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      online:true,pendingSync:1,documentQueueSynced:false,
      documentQueueError:'Сервер отклонил очередь',
    })
  })

  it('does not report queue success when the server accepts nothing',async()=>{
    const database=createDatabase([orderEvent])
    mocks.loadBootstrap.mockResolvedValueOnce(bootstrap())
    mocks.pushEvents.mockResolvedValueOnce([])

    const result=await performSync(database,connectionStore,'cashier')

    expect(database.markEventsSent).not.toHaveBeenCalled()
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({online:true,pendingSync:1,documentQueueSynced:false})
  })

  it('does not replay an accepted event on the next sync',async()=>{
    const database=createDatabase([orderEvent])
    mocks.loadBootstrap.mockResolvedValue(bootstrap([canonicalOrder]))
    mocks.pushEvents.mockResolvedValueOnce([orderEvent.id])

    await performSync(database,connectionStore,'cashier')
    await performSync(database,connectionStore,'cashier')

    expect(mocks.pushEvents).toHaveBeenCalledTimes(1)
    expect(database.markEventsSent).toHaveBeenCalledTimes(1)
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(3)
  })
})
