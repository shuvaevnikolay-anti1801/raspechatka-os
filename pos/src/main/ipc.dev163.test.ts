import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks=vi.hoisted(()=>({
  handlers:new Map<string,(event?:unknown,...args:any[])=>unknown>(),
  handle:vi.fn(),
}))
vi.mock('electron',()=>({
  ipcMain:{
    handle:(channel:string,handler:(event?:unknown,...args:any[])=>unknown)=>{
      electronMocks.handle(channel,handler)
      electronMocks.handlers.set(channel,handler)
    },
  },
}))

const syncMocks=vi.hoisted(()=>({
  configuration:vi.fn(async()=>({pointId:'point',pointName:'Point',pendingSync:1})),
  full:vi.fn(async()=>({pointId:'point',pointName:'Point',pendingSync:0})),
}))
vi.mock('./sync',()=>({
  buildBootState:vi.fn(()=>({
    pointId:'point',pointName:'Point',workplaceId:'workplace',workstationName:'POS',
    cashierName:'Выберите сотрудника',employees:[],accessRevoked:false,online:true,pendingSync:0,
    source:'frappe',shift:null,rules:{allowFreePrice:true,allowRemoveCartItem:true,allowDiscounts:true,maxDiscountPercent:100,acceptsCash:true,acceptsCard:true,acceptsQr:true},
    upsellRules:[],upsellCursors:{},
  })),
  performConfigurationSync:syncMocks.configuration,
  performSync:syncMocks.full,
}))

vi.mock('./connection',()=>({ConnectionStore:class {}}))
vi.mock('./database',()=>({PosDatabase:class {}}))
vi.mock('./diagnostics',()=>({PosDiagnostics:class {}}))
vi.mock('./print-jobs',()=>({CommodityPrintQueue:class {}}))
vi.mock('./shift-coordinator',()=>({ShiftCoordinator:class {}}))
vi.mock('./transaction-engine',()=>({PosTransactionEngine:class {}}))
vi.mock('./cashier-auth',()=>({CashierAuthSession:class {}}))
vi.mock('./pos-lifecycle',()=>({PosLifecycleStore:class {}}))
vi.mock('./frappe',()=>({getPointReceipt:vi.fn()}))

import { assertConnectionIdentityChangeAllowed, registerIpcHandlers } from './ipc'

const register=()=>{
  const diagnostics={record:vi.fn()}
  const cashierAuth={
    requireAuthenticated:vi.fn(()=>{throw new Error('cashier auth required')}),
    state:vi.fn(()=>({status:'signed_out'})),
  }
  const lifecycle={
    status:vi.fn(()=>({state:'READY'})),
    beginConfiguration:vi.fn(()=>({state:'CONFIGURING'})),
    markReady:vi.fn(()=>({state:'READY'})),
  }
  const dependencies:any={
    database:{
      currentShift:vi.fn(()=>null),
      getState:vi.fn(()=>undefined),
      setState:vi.fn(),
      clearConfirmedPointData:vi.fn(),
    },
    connectionStore:{
      load:vi.fn(()=>({serverUrl:'https://example.test',deviceId:'dev',token:'token'})),
      save:vi.fn(),
      status:vi.fn(()=>({configured:true,serverUrl:'https://example.test',deviceId:'dev'})),
    },
    paymentProvider:{},fiscalProvider:{},printProvider:{},printQueue:{},
    transactionEngine:{hasBlockingOperation:vi.fn(()=>false)},
    shiftCoordinator:{},diagnostics,cashierAuth,lifecycle,
  }
  registerIpcHandlers(dependencies)
  return {dependencies,diagnostics,cashierAuth,lifecycle}
}

beforeEach(()=>{
  electronMocks.handlers.clear()
  electronMocks.handle.mockClear()
  syncMocks.configuration.mockClear()
  syncMocks.full.mockClear()
})

describe('DEV-163 sync IPC boundary',()=>{
  it('allows configuration refresh while signed out without entering cashier full sync',async()=>{
    const {cashierAuth}=register()
    const handler=electronMocks.handlers.get('pos:sync-configuration')
    expect(handler).toBeTypeOf('function')

    await expect(handler?.()).resolves.toMatchObject({pointId:'point',pendingSync:1})
    expect(cashierAuth.requireAuthenticated).not.toHaveBeenCalled()
    expect(syncMocks.configuration).toHaveBeenCalledTimes(1)
    expect(syncMocks.full).not.toHaveBeenCalled()
  })

  it('keeps ordinary sync-now behind cashier authentication',async()=>{
    const {cashierAuth}=register()
    const handler=electronMocks.handlers.get('pos:sync-now')

    await expect(handler?.()).rejects.toThrow(/cashier auth required/)
    expect(cashierAuth.requireAuthenticated).toHaveBeenCalledTimes(1)
    expect(syncMocks.full).not.toHaveBeenCalled()
  })

  it('uses configuration-only refresh for initial setup',async()=>{
    const {lifecycle}=register()
    const handler=electronMocks.handlers.get('pos:complete-initial-setup')

    await expect(handler?.()).resolves.toMatchObject({state:'READY'})
    expect(syncMocks.configuration).toHaveBeenCalledTimes(1)
    expect(syncMocks.full).not.toHaveBeenCalled()
    expect(lifecycle.markReady).toHaveBeenCalledTimes(1)
  })
})

describe('DEV-163 connection identity guard',()=>{
  it('keeps point/device identity changes blocked while a work shift is open',()=>{
    const previous={serverUrl:'https://os.example',deviceId:'POS-1',token:'old'}
    expect(()=>assertConnectionIdentityChangeAllowed(
      previous,
      {serverUrl:'https://os.example',deviceId:'POS-2',token:'new'},
      true,
    )).toThrow(/Нельзя изменить подключение к точке во время открытой смены/)
    expect(assertConnectionIdentityChangeAllowed(
      previous,
      {serverUrl:'https://os.example/',deviceId:'POS-1',token:'rotated'},
      true,
    )).toBe(false)
  })
})
