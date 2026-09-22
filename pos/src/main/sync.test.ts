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

const bootstrapPayload=()=>({
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
        shiftTemplate:'Morning',shiftCode:'M',shiftName:'Утро',
        startTime:'09:00',endTime:'18:00',plannedHours:8,
      }],
    },
    myUpcomingShifts:[{
      id:'shift-1',date:'2026-09-20',
      shiftTemplate:'Morning',shiftCode:'M',shiftName:'Утро',
      startTime:'09:00',endTime:'18:00',plannedHours:8,
    }],
    orders:[{
      id:'ORDER-1',orderNumber:'ORD-1',phone:'+79001234567',lines:[],totalMinor:2000,paidMinor:2000,
      paymentStatus:'paid',status:'ready',createdAt:'2026-09-20T09:00:00.000Z',dueAt:'2026-09-20T10:00:00.000Z',
      readyAt:'2026-09-20T09:45:00.000Z',issuedAt:undefined,sourceSaleId:'SALE-1',fiscalNumber:'777'
    }],
  },
  upsellRules:[{triggerItem:'trigger',enabled:true,candidates:[{item:'candidate',cashierPhrase:'Попробуйте'}]}],
  rules:{allowDiscounts:true,maxDiscountPercent:20},
})

const createDatabase=(initialPending=0)=>{
  const state=new Map<string,string>()
  let pending=initialPending
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
    pendingSyncCount:()=>pending,
    currentShift:()=>null,
    pendingEvents:vi.fn(()=>pending?[{id:'event-1',type:'sale'}]:[]),
    markEventsSent:vi.fn(()=>{pending=0}),
    getUpsellCursor:(triggerItem:string)=>triggerItem==='trigger'?2:0,
  }
  return {database,state,pending:()=>pending}
}

beforeEach(()=>{
  vi.clearAllMocks()
  mocks.deferred={}
  mocks.loadBootstrap.mockImplementation(()=>new Promise((resolve)=>{mocks.deferred.resolve=resolve}))
  mocks.pushEvents.mockResolvedValue([])
})

describe('performSync single flight',()=>{
  it('coalesces a manual and background request for the same database',async()=>{
    const {database}=createDatabase()
    const first=performSync(database,connectionStore,'cashier')
    const second=performSync(database,connectionStore,'cashier')
    expect(second).toBe(first)
    expect(mocks.loadBootstrap).toHaveBeenCalledTimes(1)
    mocks.deferred.resolve?.(bootstrapPayload())
    await expect(first).resolves.toMatchObject({online:true,pendingSync:0})
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
    expect((await first).upsellCursors).toEqual({trigger:2})
    expect(mocks.pushEvents).not.toHaveBeenCalled()
  })
})

describe('DEV-163 configuration versus business sync boundary',()=>{
  it('refreshes bootstrap while signed out without pushing or marking business outbox events',async()=>{
    const {database,pending}=createDatabase(1)
    mocks.loadBootstrap.mockResolvedValueOnce(bootstrapPayload())

    const result=await performConfigurationSync(database,connectionStore)

    expect(mocks.loadBootstrap).toHaveBeenCalledWith(connection,undefined)
    expect(mocks.pushEvents).not.toHaveBeenCalled()
    expect(database.pendingEvents).not.toHaveBeenCalled()
    expect(database.markEventsSent).not.toHaveBeenCalled()
    expect(pending()).toBe(1)
    expect(result).toMatchObject({source:'frappe',online:true,pendingSync:1})
    expect(database.replaceProducts).toHaveBeenCalled()
    expect(database.replacePointEmployees).toHaveBeenCalled()
    expect(database.setWorkplaceData).toHaveBeenCalled()
  })

  it('keeps full cashier sync responsible for pushing and marking the business outbox',async()=>{
    const {database,pending}=createDatabase(1)
    mocks.loadBootstrap.mockResolvedValueOnce(bootstrapPayload())
    mocks.pushEvents.mockResolvedValueOnce(['event-1'])

    const result=await performSync(database,connectionStore,'cashier-a')

    expect(mocks.loadBootstrap).toHaveBeenCalledWith(connection,'cashier-a')
    expect(mocks.pushEvents).toHaveBeenCalledTimes(1)
    expect(database.pendingEvents).toHaveBeenCalled()
    expect(database.markEventsSent).toHaveBeenCalledWith(['event-1'])
    expect(pending()).toBe(0)
    expect(result.pendingSync).toBe(0)
  })
})
