import { describe, expect, it } from 'vitest'
import { normalizeWorkplaceData } from './database'

describe('workplace schedule compatibility',()=>{
  it('adds safe schedule defaults to an old cached workplace snapshot',()=>{
    const value=normalizeWorkplaceData({
      schedule:[],
      deliveries:[],
      supplyRequests:[],
      cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},
      orders:[],
    })
    expect(value.scheduleMonth.employees).toEqual([])
    expect(value.scheduleMonth.entries).toEqual([])
    expect(value.myUpcomingShifts).toEqual([])
    expect(value.operationalCatalog).toEqual([])
    expect(value.scheduleMonth.month).toMatch(/^\d{4}-\d{2}$/)
  })
  it('preserves published schedule data and upcoming shifts',()=>{
    const value=normalizeWorkplaceData({
      schedule:[],
      scheduleMonth:{month:'2026-09',days:30,employees:[{id:'e1',name:'Иван'}],entries:[]},
      myUpcomingShifts:[{id:'s1',date:'2026-10-01',shiftTemplate:'tpl',shiftCode:'U',shiftName:'Утро',startTime:'09:00:00',endTime:'18:00:00',plannedHours:8}],
      deliveries:[],supplyRequests:[],cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},orders:[],
    })
    expect(value.scheduleMonth.month).toBe('2026-09')
    expect(value.myUpcomingShifts).toHaveLength(1)
  })
})
