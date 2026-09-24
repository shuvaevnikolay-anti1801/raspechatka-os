import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>({
  deferred:{} as {resolve?: (value:any)=>void},
  loadBootstrap:vi.fn(),
  pushEvents:vi.fn(),
}))
vi.mock('./frappe',()=>({loadBootstrap:mocks.loadBootstrap,pushEvents:mocks.pushEvents}))

import { buildBootState, discardSingleSyncEvent, normalizeCleaningConfig, performConfigurationSync, performSync, retrySingleSyncEvent, withOutboxLock } from './sync'

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
  let queuedEvents:any[]=initialEvents?[...initialEvents]:Array.from({length:initialPending},(_,index)=>({
    id:`event-${index+1}`,eventType:'order.created',payload:{orderNumber:'ORD-1'}
  }))
  const sentEvents=new Map<string,any>()
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
    pendingSyncCount:()=>queuedEvents.filter((event)=>event.status!=='discarded').length,
    currentShift:()=>null,
    pendingEvents:vi.fn((limit=100)=>queuedEvents.filter((event)=>(!event.status||event.status==='pending')&&(!event.nextAttemptAt||event.nextAttemptAt<=new Date().toISOString())).slice(0,limit)),
    getQueueEvent:vi.fn((id:string)=>queuedEvents.find((event)=>event.id===id)||sentEvents.get(id)),
    discardQueueEvent:vi.fn((id:string)=>{
      const found=queuedEvents.find((event)=>event.id===id)
      if(!found)return false
      found.status='discarded'
      return true
    }),
    recordEventsAttempted:vi.fn((ids:string[])=>queuedEvents.forEach((event)=>{if(ids.includes(event.id))event.attemptCount=(event.attemptCount||0)+1})),
    recordEventFailure:vi.fn((ids:string[],kind:string)=>queuedEvents.forEach((event)=>{if(ids.includes(event.id)){event.status=kind==='problem'?'problem':'pending';event.nextAttemptAt=kind==='problem'?null:new Date(Date.now()+5000).toISOString()}})),
    markEventsSent:vi.fn((ids:string[])=>{
      const accepted=new Set(ids)
      queuedEvents=queuedEvents.filter((event)=>{
        if(!accepted.has(event.id))return true
        sentEvents.set(event.id,{...event,status:'sent'})
        return false
      })
    }),
    getUpsellCursor:(triggerItem:string)=>triggerItem==='trigger'?2:0,
  }
  return {
    database,state,
    pending:()=>queuedEvents.length,
    pendingIds:()=>queuedEvents.map((event)=>event.id),
    events:()=>queuedEvents,
  }
}

beforeEach(()=>{
  vi.clearAllMocks()
  mocks.deferred={}
  mocks.loadBootstrap.mockReset()
  mocks.pushEvents.mockReset()
})

describe('exact manual outbox action',()=>{
  const event=(id:string,status='pending')=>({
    id,eventType:'order.created',payload:{orderNumber:id},createdAt:'2026-09-20T00:00:00Z',
    status,attemptCount:0,lastAttemptAt:null,nextAttemptAt:null,lastError:null,sentAt:null,
  })
  it('sends exactly one immutable event, including a problem, and leaves the other untouched',async()=>{
    const {database,events}=createDatabase(0,[event('chosen','problem'),event('other')])
    mocks.pushEvents.mockResolvedValue({accepted:['chosen'],errors:[]})
    const result=await retrySingleSyncEvent(database,connectionStore,'chosen')
    expect(mocks.pushEvents).toHaveBeenCalledWith(connection,[expect.objectContaining({id:'chosen',payload:{orderNumber:'chosen'}})])
    expect(database.recordEventsAttempted).toHaveBeenCalledWith(['chosen'],expect.any(String),true)
    expect(result.event.status).toBe('sent')
    expect(events()).toMatchObject([{id:'other',attemptCount:0}])
  })
  it('records transport failure only for the selected event',async()=>{
    const {database,events}=createDatabase(0,[event('chosen'),event('other')])
    mocks.pushEvents.mockRejectedValue(new Error('secret transport error'))
    const result=await retrySingleSyncEvent(database,connectionStore,'chosen')
    expect(result.event.attemptCount).toBe(1)
    expect(result.message).not.toContain('secret')
    expect(events().find((row)=>row.id==='other')?.attemptCount).toBe(0)
    expect(database.recordEventFailure).toHaveBeenCalledWith(['chosen'],'temporary','transport')
  })
  it('keeps a rejected problem visible with its updated attempt',async()=>{
    const {database,events}=createDatabase(0,[event('chosen','problem'),event('other')])
    mocks.pushEvents.mockResolvedValue({accepted:[],errors:[{
      id:'chosen',eventType:'order.created',message:'ValidationError: rejected',
    }]})
    const result=await retrySingleSyncEvent(database,connectionStore,'chosen')
    expect(result.event).toMatchObject({status:'problem',attemptCount:1})
    expect(result.message).toContain('не подтвердил')
    expect(events().find((row)=>row.id==='other')?.attemptCount).toBe(0)
    expect(database.recordEventFailure).toHaveBeenCalledWith(['chosen'],'problem','validation')
  })
  it('waits for an in-flight sync before checking whether the event was accepted',async()=>{
    const {database}=createDatabase(0,[event('chosen')])
    let release:()=>void=()=>undefined
    const active=withOutboxLock(database,()=>new Promise<void>((resolve)=>{release=resolve}))
    const manual=retrySingleSyncEvent(database,connectionStore,'chosen')
    database.markEventsSent(['chosen'])
    release()
    await active
    await expect(manual).rejects.toThrow('Повтор этого события сейчас недоступен')
    expect(mocks.pushEvents).not.toHaveBeenCalled()
  })
  it('does not retry an event accepted by the active automatic sync',async()=>{
    const {database}=createDatabase(0,[event('chosen')])
    mocks.loadBootstrap.mockResolvedValue(bootstrapPayload())
    let accept:(value:any)=>void=()=>undefined
    mocks.pushEvents.mockImplementation(()=>new Promise((resolve)=>{accept=resolve}))
    const automatic=performSync(database,connectionStore,'cashier')
    const manual=retrySingleSyncEvent(database,connectionStore,'chosen')
    await vi.waitFor(()=>expect(mocks.pushEvents).toHaveBeenCalledTimes(1))
    accept({accepted:['chosen'],errors:[]})
    await automatic
    await expect(manual).rejects.toThrow('Повтор этого события сейчас недоступен')
    expect(mocks.pushEvents).toHaveBeenCalledTimes(1)
  })
  it('audits owner discard, keeps payload, and refuses discard after an in-flight acceptance',async()=>{
    const {database}=createDatabase(0,[event('chosen'),event('other')])
    const audit=vi.fn()
    const discarded=await discardSingleSyncEvent(database,'chosen',()=>false,audit)
    expect(discarded).toMatchObject({id:'chosen',status:'discarded',payload:{orderNumber:'chosen'}})
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({id:'chosen',eventType:'order.created'}))
    expect(database.getQueueEvent('other').status).toBe('pending')

    let release:()=>void=()=>undefined
    const active=withOutboxLock(database,()=>new Promise<void>((resolve)=>{release=resolve}))
    const late=discardSingleSyncEvent(database,'other',()=>false,audit)
    database.markEventsSent(['other'])
    release()
    await active
    await expect(late).rejects.toThrow('Документ уже отправлен')
    expect(audit).toHaveBeenCalledTimes(1)
  })
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

  it('continues into later batches after a partial rejection',async()=>{
    const events=Array.from({length:101},(_,index)=>({
      id:`event-${index}`,eventType:index===0?'future.event':'order.created',payload:{},
    }))
    const {database,events:remaining}=createDatabase(0,events)
    mocks.loadBootstrap.mockResolvedValue(bootstrapPayload([]))
    mocks.pushEvents
      .mockResolvedValueOnce({
        accepted:events.slice(1,100).map((event)=>event.id),
        errors:[{id:'event-0',eventType:'future.event',message:'Неподдерживаемый тип события: future.event'}],
      })
      .mockResolvedValueOnce({accepted:['event-100'],errors:[]})
    await performSync(database,connectionStore,'cashier')
    expect(mocks.pushEvents).toHaveBeenCalledTimes(2)
    expect(remaining()).toMatchObject([{id:'event-0',status:'problem'}])
    expect(database.markEventsSent).toHaveBeenCalledWith(['event-100'])
  })

  it('persists one attempt for a transport failure and skips it while not due',async()=>{
    const {database,events}=createDatabase(1)
    mocks.loadBootstrap.mockResolvedValue(bootstrapPayload([]))
    mocks.pushEvents.mockRejectedValueOnce(new Error('network'))
    await performSync(database,connectionStore,'cashier')
    await performSync(database,connectionStore,'cashier')
    expect(mocks.pushEvents).toHaveBeenCalledTimes(1)
    expect(database.recordEventsAttempted).toHaveBeenCalledTimes(1)
    expect(events()[0]).toMatchObject({attemptCount:1,status:'pending'})
    expect(events()[0].nextAttemptAt).toBeTruthy()
  })

  it('marks explicit unsupported responses problem while sending later valid events',async()=>{
    const {database,events}=createDatabase(0,[
      {id:'bad',eventType:'future.event',payload:{}},
      {id:'good',eventType:'order.created',payload:{}},
    ])
    mocks.loadBootstrap.mockResolvedValue(bootstrapPayload([]))
    mocks.pushEvents.mockResolvedValueOnce({
      accepted:['good'],errors:[{id:'bad',eventType:'future.event',message:'Неподдерживаемый тип события: future.event'}],
    })
    await performSync(database,connectionStore,'cashier')
    expect(database.markEventsSent).toHaveBeenCalledWith(['good'])
    expect(events()).toMatchObject([{id:'bad',status:'problem',attemptCount:1}])
    await performSync(database,connectionStore,'cashier')
    expect(mocks.pushEvents).toHaveBeenCalledTimes(1)
  })

})

describe('point cleaning bootstrap',()=>{
  it('normalizes an old cached snapshot and invalid values to 2000 ₽ / 4',()=>{
    const {database,state}=createDatabase()
    state.set('bootstrap',JSON.stringify({pointId:'point',source:'frappe'}))
    expect(buildBootState(database).cleaning).toEqual({payoutAmountMinor:200000,everyNVisits:4})
    expect(normalizeCleaningConfig({payoutAmountMinor:0,everyNVisits:0})).toEqual({payoutAmountMinor:200000,everyNVisits:4})
  })

  it('stores custom cleaning configuration from the point bootstrap',async()=>{
    const {database}=createDatabase()
    mocks.loadBootstrap.mockResolvedValueOnce({
      ...bootstrapPayload([]),
      point:{id:'point',name:'Point',cleaning:{payoutAmountMinor:325050,everyNVisits:6}},
    })
    const result=await performConfigurationSync(database,connectionStore)
    expect(result.cleaning).toEqual({payoutAmountMinor:325050,everyNVisits:6})
    expect(buildBootState(database).cleaning).toEqual(result.cleaning)
  })
})
