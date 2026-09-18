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
      workplaceData:{orders:[]},rules:{allowDiscounts:true,maxDiscountPercent:20},
    })
    await expect(first).resolves.toMatchObject({online:true,pendingSync:0})
    expect(mocks.pushEvents).not.toHaveBeenCalled()
  })
})
