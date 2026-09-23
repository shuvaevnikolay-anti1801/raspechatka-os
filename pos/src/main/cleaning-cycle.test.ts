import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PosDatabase } from './database'

const folders:string[]=[]
const databases:PosDatabase[]=[]
function open(file:string){
  const database=new PosDatabase(file)
  databases.push(database)
  return database
}
function file(){
  const folder=mkdtempSync(join(tmpdir(),'cleaner-cycle-'))
  folders.push(folder)
  return join(folder,'pos.sqlite')
}
function configure(database:PosDatabase,pointId='point-a',workplaceId='pos-a',everyNVisits=4,payoutAmountMinor=200000){
  database.setState('bootstrap',JSON.stringify({
    pointId,workplaceId,pointTimezone:'Europe/Moscow',
    cleaning:{everyNVisits,payoutAmountMinor},
  }))
}
function shift(database:PosDatabase,id='shift-a'){
  database.openShift({id,openedAt:new Date().toISOString(),cashierId:'EMP-A',cashierName:'Кассир'})
}
function visitEvents(database:PosDatabase){
  return database.pendingEvents().filter((event)=>event.eventType==='cleaner.visit.recorded')
}
afterEach(()=>{
  vi.useRealTimers()
  databases.splice(0).forEach((database)=>database.close())
  folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))
})

describe('durable cleaning cycle',()=>{
  it('reaches custom N and blocks N+1 while preserving the due state after restart/offline',()=>{
    vi.useFakeTimers()
    const path=file()
    let database=open(path)
    configure(database,'point-a','pos-a',3,325050)
    vi.setSystemTime(new Date('2026-09-01T22:30:00.000Z'))
    shift(database)
    for(let i=0;i<2;i++){
      vi.setSystemTime(new Date(Date.UTC(2026,8,i+1,22,30)))
      expect(database.recordCleanerVisit('untrusted').visitsSincePayment).toBe(i+1)
      expect(database.getWorkplaceData().cleaner.payoutState).toBe('not_due')
    }
    vi.setSystemTime(new Date('2026-09-03T22:30:00.000Z'))
    const due=database.recordCleanerVisit('untrusted')
    expect(due).toMatchObject({visitsSincePayment:3,paymentDueMinor:325050})
    expect(due.visit).toMatchObject({visitDate:'2026-09-04',recordedBy:'Кассир'})
    expect(database.getWorkplaceData().cleaner).toMatchObject({
      schemaVersion:1,payoutState:'due',everyNVisits:3,payoutAmountMinor:325050,
    })
    database.close();databases.splice(databases.indexOf(database),1)
    database=open(path)
    expect(database.recordCleanerVisit('again').visit.id).toBe(due.visit.id)
    vi.setSystemTime(new Date('2026-09-04T22:30:00.000Z'))
    expect(()=>database.recordCleanerVisit('Кассир')).toThrow('Сначала завершите выплату')
    expect(visitEvents(database)).toHaveLength(3)
    expect(()=>database.payCleaner(325050)).toThrow('временно недоступна')
    expect(database.listCashOperations()).toHaveLength(0)
    expect(database.getWorkplaceData().cleaner.payoutState).toBe('due')
  })

  it('uses a point-local date, queues one stable event with trusted cashier, and ignores replay after ack',()=>{
    vi.useFakeTimers()
    const database=open(file())
    configure(database)
    vi.setSystemTime(new Date('2026-09-01T21:30:00.000Z'))
    shift(database)
    const first=database.recordCleanerVisit('forged')
    expect(first.visit.visitDate).toBe('2026-09-02')
    vi.setSystemTime(new Date('2026-09-02T18:00:00.000Z'))
    expect(database.recordCleanerVisit('other').visit.id).toBe(first.visit.id)
    const [event]=visitEvents(database)
    expect(visitEvents(database)).toHaveLength(1)
    expect(event.id).toBe(first.visit.id)
    expect(event.payload).toMatchObject({
      id:first.visit.id,visitDate:'2026-09-02',recordedBy:'Кассир',cashierId:'EMP-A',shiftId:'shift-a',
    })
    database.markEventsSent([event.id])
    expect(database.recordCleanerVisit('again').visit.id).toBe(first.visit.id)
    expect(visitEvents(database)).toHaveLength(0)
    database.setWorkplaceData({cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]}})
    expect(database.getWorkplaceData().cleaner.visitsSincePayment).toBe(1)
  })

  it('migrates an older cached cleaner state once and keeps it through restart',()=>{
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T22:30:00.000Z'))
    const path=file()
    let database=open(path)
    configure(database)
    database.setWorkplaceData({cleaner:{
      visitsSincePayment:3,paymentDueMinor:0,
      recentVisits:[{id:'legacy-visit',visitDate:'2026-09-03',recordedBy:'Кассир',paid:false}],
    }})
    shift(database)
    expect(database.recordCleanerVisit('Кассир')).toMatchObject({visitsSincePayment:4,paymentDueMinor:200000})
    database.close();databases.splice(databases.indexOf(database),1)
    database=open(path)
    expect(database.getWorkplaceData().cleaner).toMatchObject({schemaVersion:1,visitsSincePayment:4,payoutState:'due'})
    expect(visitEvents(database)).toHaveLength(1)
  })

  it('maps an older UTC-dated queued visit to the point-local date during migration',()=>{
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T23:30:00.000Z'))
    const path=file()
    let database=open(path)
    configure(database,'point-a','pos-a',2)
    database.setWorkplaceData({cleaner:{
      visitsSincePayment:1,paymentDueMinor:0,
      recentVisits:[{id:'old-visit',visitDate:'2026-09-01',recordedBy:'Кассир',paid:false}],
    }})
    database.close();databases.splice(databases.indexOf(database),1)
    const sqlite=new DatabaseSync(path)
    sqlite.prepare('INSERT INTO outbox (id,event_type,payload_json,created_at) VALUES (?,?,?,?)')
      .run('old-event','cleaner.visit.recorded',JSON.stringify({id:'old-visit',visitDate:'2026-09-01'}),'2026-09-01T22:30:00.000Z')
    sqlite.close()
    database=open(path)
    shift(database)
    expect(database.recordCleanerVisit('Кассир').visit).toMatchObject({id:'old-visit',visitDate:'2026-09-02'})
    expect(visitEvents(database)).toHaveLength(1)
    vi.setSystemTime(new Date('2026-09-02T22:30:00.000Z'))
    expect(database.recordCleanerVisit('Кассир').paymentDueMinor).toBe(200000)
  })

  it('separates point/workplace cycles and rejects a shift bound to another point',()=>{
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T22:30:00.000Z'))
    const path=file()
    let database=open(path)
    configure(database,'point-a','pos-a',2)
    shift(database)
    database.recordCleanerVisit('Кассир')
    configure(database,'point-b','pos-b',5)
    expect(()=>database.recordCleanerVisit('Кассир')).toThrow('другой точке')
    database.close();databases.splice(databases.indexOf(database),1)
    const sqlite=new DatabaseSync(path)
    sqlite.prepare("UPDATE shifts SET closed_at=? WHERE id='shift-a'").run('2026-09-02T01:00:00.000Z')
    sqlite.close()
    database=open(path)
    shift(database,'shift-b')
    expect(database.recordCleanerVisit('Кассир').visitsSincePayment).toBe(1)
    expect(database.getWorkplaceData().cleaner.everyNVisits).toBe(5)
    configure(database,'point-a','pos-a',2)
    expect(database.getWorkplaceData().cleaner.visitsSincePayment).toBe(1)
  })
})
