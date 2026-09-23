import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBootstrap } from './frappe'

afterEach(()=>{
  vi.unstubAllGlobals()
})

describe('loadBootstrap workplace schedule normalization',()=>{
  it('normalizes a legacy bootstrap that only has scheduleMonth',async()=>{
    const legacyMonth={
      month:'2026-12',days:31,
      employees:[{id:'EMP-1',name:'Анна'}],
      entries:[{
        id:'WS-1',date:'2026-12-31',employeeId:'EMP-1',employeeName:'Анна',
        shiftTemplate:'SHIFT-U',shiftCode:'U',shiftName:'Утро',startTime:'09:00:00',endTime:'15:00:00',plannedHours:6
      }]
    }
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
      message:{
        point:{id:'POINT-1',name:'Точка 1'},
        workplace:{id:'POS-1',name:'Касса 1'},
        employee:null,
        employees:[],
        rules:{},
        upsellRules:[],
        products:[],
        customers:[],
        workplaceData:{
          schedule:[],
          scheduleMonth:legacyMonth,
          myUpcomingShifts:[],
          operationalCatalog:[],
          deliveries:[],
          supplyRequests:[],
          cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},
          orders:[],
        },
        receiptMirror:[],
        retentionDays:30,
      }
    }),{status:200,headers:{'Content-Type':'application/json'}})))

    const bootstrap=await loadBootstrap({
      serverUrl:'https://example.test',
      deviceId:'DEVICE-1',
      token:'TOKEN-1',
    })

    expect(bootstrap.workplaceData.scheduleCurrentMonth).toEqual(legacyMonth)
    expect(bootstrap.workplaceData.scheduleMonth).toEqual(legacyMonth)
    expect(bootstrap.workplaceData.scheduleNextMonth).toEqual({
      month:'2027-01',days:31,employees:[],entries:[]
    })
  })
})
