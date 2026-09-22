import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>({
  deferred:{} as {resolve?: (value:any)=>void},
  loadBootstrap:vi.fn(),
  pushEvents:vi.fn(),
}))
vi.mock('./frappe',()=>({loadBootstrap:mocks.loadBootstrap,pushEvents:mocks.pushEvents}))

import { performConfigurationSync, performSync } from './sync'

const connection={serverUrl:'https://example.test',deviceId:'dev',token:'token'}
const connectionStore:any={load:()=>connection}

const canonicalOrder={
  id:'ORDER-1',orderNumber:'ORD-1',phone:'+79001234567',lines:[],totalMinor:2000,paidMinor:2000,
  paymentStatus:'paid',status:'ready',createdAt:'2026-09-20T09:00:00.000Z',
  readyAt:'2026-09-20T09:45:00.000Z',sourceSaleId:'SALE-1',fiscalNumber:'777'
}
const bootstrapPayload=(orders:any[]=[canonicalOrder])=>({
  products:[],customers:[],employees:[],receiptMirror:[],retentionDays:60,
  point:{id:'point',name:'Point'},
  workplace:{id:'workplace',name:'POS'},
  workplaceData:{
    schedule:[],
    scheduleMonth:{
      month:'2026-09',days:30,
      employees:[{id:'cashier',name:'Кассир'}],
      entries:[{
        id:'shift-1',date:'2026-09-20',employeeId:'cashier',
        shiftTemplate:'Morning',shiftCode:'U',shiftName:'Утро',
        startTime:'09:00',endTime:'18:00',plannedHours:8,
      }],
    },
    myUpcomingShifts:[{
      id:'shift-1',date:'2026-09-20',
      shiftTemplate:'Morning',shiftCode:'U',shiftName:'Утро',
      startTime:'09:00',endTime:'18:00',plannedHours:8,
    }],
    orders,
  },
  upsellRules:[{triggerItem:'trigger',enabled:true,candidates:[{item:'candidate',cashierPhrase:'Попробуйте'}]}],
  rules:{allowDiscounts:true,maxDiscountPercent:20},
})

const createDatabase=(initialPending=0,initialEvents?:any[])=>{
  const state=new Map<string,string>()
  let queuedEvents=initialEvents?[...initialEvents]:Array.from({length:initialPending},(_,index)=>({
    id:`event-${index+1}`,eventType:'order.created',payload:{orderNumber:'ORD-1'}
  }))
  const database:any={
    getState:(key:string)=>state.get(key),
    setState:vi.fn((key:string,value:string)=>state.set(key,value)),
    replaceProducts:vi.fn(),
    replaceCustomers:vi.fn(),
    replacePointEmployees:vi.fn(),
    replaceReceiptMirror:vi.fn(),
    replaceServerOrders:vi.fn(),
    setWorkplaceData:vi.fn(),
    listPointEmployees:()=>[],
    pendingSyncCount:()=>queuedEvents.length,
    currentShift:()=>null,
    pendingEvents:vi.fn((limit=100)=>queuedEvents.slice(0,limit)),
    markEventsSent:vi.fn((ids:string[])=>{
      const accepted=new Set(ids)
      queuedEvents=queuedEvents.filter((event)=>!accepted.has(event.id))
    }),
    getUpsellCursor:(triggerItem:string)=>triggerItem==='trigger'?2:0,
  }
  return {
    database,state,
    pending:()=>queuedEvents.length,
    pendingIds:()=>queuedEvents.map((event)=>event.id),
  }
}

beforeEach(()=>{
  vi.clearAllMocks()
  mocks.deferred={}
  mocks.loadBootstrap.mockReset()
  mocks.pushEvents.mockReset()
})

describe('performSync single flight',()=>{
  it('coalesces a manual and background request for the same database',async()=>{
    const {database}=createDatabase()
    mocks.loadBootstrap.mockImplementation(()=>new Promise((resolve)=>{mocks.deferred.resolve=resolve}))
    mocks.pushEvents.mockResolvedValue({accepted:[],errors:[]})
    const first=performSync(database,connectionStore,'cashier')
    const second=performSync(database,connectionStore,'cashier')
    expect(second).toBe(first)
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(1)
    mocks.deferred.resolve?.(bootstrapPayload())
    await expect(first).resolves.toMatchObject({online:true,pendingSync:0,documentQueueSynced:true})
    expect(database.replaceServerOrders).toHaveBeenCalledWith(
      'point',
      [expect.objectContaining({id:'ORDER-1',readyAt:'2026-09-20T09:45:00.000Z',sourceSaleId:'SALE-1'})],
      60,
    )
    expect(database.setState).toHaveBeenCalledWith('bootstrap',expect.stringContaining('"upsellRules"'))
    expect(database.setWorkplaceData).toHaveBeenCalledWith(expect.objectContaining({
      scheduleMonth:expect.objectContaining({month:'2026-09',entries:expect.arrayContaining([expect.objectContaining({id:'shift-1'})])}),
      myUpcomingShifts:expect.arrayContaining([expect.objectContaining({id:'shift-1'})]),
    }))
    expect((await first).upsellRules).toEqual([
      {triggerItem:'trigger',enabled:true,candidates:[{item:'candidate',cashierPhrase:'Попробуйте'}]},
    ])
    expect(mocks.pushEvents).not.toHaveBeenCalled()
  })
})

describe('configuration versus business sync boundary',()=>{
  it('refreshes bootstrap while signed out without pushing or marking business outbox events',async()=>{
    const {database,pending}=createDatabase(1)
    mocks.loadBootstrap.mockResolvedValueOnce(bootstrapPayload())

    const result=await performConfigurationSync(database,connectionStore)

    expect(mocks.loadBootstrap).toHaveBeenCalledWith(connection,undefined)
    expect(mocks.pushEvents).not.toHaveBeenCalled()
    expect(database.pendingEvents).not.toHaveBeenCalled()
    expect(database.markEventsSent).not.toHaveBeenCalled()
    expect(pending()).toBe(1)
    expect(result).toMatchObject({source:'frappe',online:true,pendingSync:1,documentQueueSynced:false})
  })

  it('keeps full cashier sync responsible for pushing and marking the business outbox',async()=>{
    const {database,pending}=createDatabase(1)
    mocks.loadBootstrap
      .mockResolvedValueOnce(bootstrapPayload([]))
      .mockResolvedValueOnce(bootstrapPayload([canonicalOrder]))
    mocks.pushEvents.mockResolvedValueOnce({accepted:['event-1'],errors:[]})

    const result=await performSync(database,connectionStore,'cashier-a')

    expect(mocks.loadBootstrap).toHaveBeenNthCalledWith(1,connection,'cashier-a')
    expect(mocks.pushEvents).toHaveBeenCalledTimes(1)
    expect(database.markEventsSent).toHaveBeenCalledWith(['event-1'])
    expect(pending()).toBe(0)
    expect(result).toMatchObject({pendingSync:0,documentQueueSynced:true})
  })
})

describe('read-after-write and truthful queue state',()=>{
  it('refreshes canonical orders after accepted events in the same cycle',async()=>{
    const {database}=createDatabase(1)
    mocks.loadBootstrap
      .mockResolvedValueOnce(bootstrapPayload([]))
      .mockResolvedValueOnce(bootstrapPayload([canonicalOrder]))
    mocks.pushEvents.mockResolvedValueOnce({accepted:['event-1'],errors:[]})

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
    const {database,pending}=createDatabase(1)
    mocks.loadBootstrap.mockResolvedValueOnce(bootstrapPayload([]))
    mocks.pushEvents.mockRejectedValueOnce(new Error('Сервер отклонил очередь'))

    const result=await performSync(database,connectionStore,'cashier')

    expect(database.markEventsSent).not.toHaveBeenCalled()
    expect(pending()).toBe(1)
    expect(result).toMatchObject({
      online:true,pendingSync:1,documentQueueSynced:false,
      documentQueueError:'Сервер отклонил очередь',
    })
  })

  it('marks only accepted ids, keeps rejected ids pending, and reads back after partial success',async()=>{
    const events=[
      {id:'event-1',eventType:'order.updated',payload:{orderNumber:'ORD-MISSING'}},
      {id:'event-2',eventType:'order.created',payload:{orderNumber:'ORD-2'}},
    ]
    const {database,pending,pendingIds}=createDatabase(0,events)
    mocks.loadBootstrap
      .mockResolvedValueOnce(bootstrapPayload([]))
      .mockResolvedValueOnce(bootstrapPayload([canonicalOrder]))
    mocks.pushEvents.mockResolvedValueOnce({
      accepted:['event-2'],
      errors:[{id:'event-1',eventType:'order.updated',message:'Заказ не найден'}],
    })

    const result=await performSync(database,connectionStore,'cashier')

    expect(mocks.pushEvents).toHaveBeenCalledTimes(1)
    expect(database.markEventsSent).toHaveBeenCalledWith(['event-2'])
    expect(pending()).toBe(1)
    expect(pendingIds()).toEqual(['event-1'])
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      online:true,
      pendingSync:1,
      documentQueueSynced:false,
      documentQueueError:'order.updated (event-1): Заказ не найден',
    })
  })

  it('keeps an unsupported event pending with its server error',async()=>{
    const events=[{id:'event-unsupported',eventType:'future.event',payload:{}}]
    const {database,pendingIds}=createDatabase(0,events)
    mocks.loadBootstrap.mockResolvedValueOnce(bootstrapPayload([]))
    mocks.pushEvents.mockResolvedValueOnce({
      accepted:[],
      errors:[{
        id:'event-unsupported',
        eventType:'future.event',
        message:'Неподдерживаемый тип события: future.event',
      }],
    })

    const result=await performSync(database,connectionStore,'cashier')

    expect(mocks.pushEvents).toHaveBeenCalledTimes(1)
    expect(database.markEventsSent).not.toHaveBeenCalled()
    expect(pendingIds()).toEqual(['event-unsupported'])
    expect(result).toMatchObject({
      pendingSync:1,
      documentQueueSynced:false,
      documentQueueError:'future.event (event-unsupported): Неподдерживаемый тип события: future.event',
    })
  })

  it('does not report queue success when the server accepts nothing',async()=>{
    const {database,pending}=createDatabase(1)
    mocks.loadBootstrap.mockResolvedValueOnce(bootstrapPayload([]))
    mocks.pushEvents.mockResolvedValueOnce({accepted:[],errors:[]})

    const result=await performSync(database,connectionStore,'cashier')

    expect(database.markEventsSent).not.toHaveBeenCalled()
    expect(pending()).toBe(1)
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({online:true,pendingSync:1,documentQueueSynced:false})
  })

  it('does not replay an accepted event on the next full sync',async()=>{
    const {database}=createDatabase(1)
    mocks.loadBootstrap.mockResolvedValue(bootstrapPayload([canonicalOrder]))
    mocks.pushEvents.mockResolvedValueOnce({accepted:['event-1'],errors:[]})

    await performSync(database,connectionStore,'cashier')
    await performSync(database,connectionStore,'cashier')

    expect(mocks.pushEvents).toHaveBeenCalledTimes(1)
    expect(database.markEventsSent).toHaveBeenCalledTimes(1)
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(3)
  })
})
