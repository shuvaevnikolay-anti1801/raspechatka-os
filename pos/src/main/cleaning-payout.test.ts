import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PosDatabase } from './database'

const folders:string[]=[]
const databases:PosDatabase[]=[]
function file(){
  const folder=mkdtempSync(join(tmpdir(),'cleaner-payout-'))
  folders.push(folder)
  return join(folder,'pos.sqlite')
}
function open(path:string){
  const db=new PosDatabase(path)
  databases.push(db)
  return db
}
function setup(db:PosDatabase,n=2,amount=325050){
  db.setState('bootstrap',JSON.stringify({
    pointId:'POINT-A',workplaceId:'POS-A',pointTimezone:'Europe/Moscow',
    cleaning:{everyNVisits:n,payoutAmountMinor:amount},
  }))
  db.openShift({id:'SHIFT-A',openedAt:new Date().toISOString(),cashierId:'EMP-A',cashierName:'Кассир'})
  db.saveCashCount('opening',[])
}
function due(db:PosDatabase,n=2){
  for(let index=0;index<n;index++){
    vi.setSystemTime(new Date(Date.UTC(2026,8,index+1,22,30)))
    db.recordCleanerVisit('Кассир')
  }
  return db.getWorkplaceData().cleaner.cycleId!
}
afterEach(()=>{
  vi.useRealTimers()
  databases.splice(0).forEach((db)=>db.close())
  folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))
})

describe('cleaner payout through standard cash withdrawal',()=>{
  it('persists one custom payout, one withdrawal and one drawer effect across duplicates and outbox replay',()=>{
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T08:00:00Z'))
    const db=open(file())
    setup(db,2,325050)
    vi.setSystemTime(new Date('2026-09-01T08:01:00Z'))
    db.addCashOperation('deposit',500000,'float')
    const cycleId=due(db)
    const payout=db.prepareCleanerPayout(cycleId)
    expect(db.prepareCleanerPayout(cycleId).id).toBe(payout.id)
    expect(payout).toMatchObject({status:'withdrawal_pending',amountMinor:325050,everyNVisits:2})
    expect(payout.visitEventIds).toHaveLength(2)
    expect(db.getWorkplaceData().cleaner.payoutState).toBe('withdrawal_pending')
    const before=db.getShiftSummary().expectedCashMinor
    const operation=db.addCashOperation('withdrawal',payout.amountMinor,'ignored',payout.id)
    expect(operation).toMatchObject({type:'withdrawal',amountMinor:325050,cleaningPayoutId:payout.id})
    expect(db.getShiftSummary().expectedCashMinor).toBe(before-325050)
    expect(db.getWorkplaceData().cleaner).toMatchObject({visitsSincePayment:0,payoutState:'not_due'})
    expect(db.getWorkplaceData().cleaner.recentVisits.filter((visit)=>visit.paid)).toHaveLength(2)
    const event=db.pendingEvents().find((item)=>item.eventType==='cash.withdrawn')!
    expect(event.id).toBe(operation.id)
    expect(event.payload).toMatchObject({
      cleaningPayoutId:payout.id,cleaningCycleId:cycleId,
      cleaningVisitEventIds:payout.visitEventIds,withdrawalPurpose:'Expense',
    })
    db.markEventsSent([event.id])
    expect(db.addCashOperation('withdrawal',payout.amountMinor,'ignored',payout.id).id).toBe(operation.id)
    expect(db.getShiftSummary().expectedCashMinor).toBe(before-325050)
    expect(db.listCashOperations().filter((item)=>item.type==='withdrawal')).toHaveLength(1)
    expect(db.pendingEvents().filter((item)=>item.eventType==='cash.withdrawn')).toHaveLength(0)
  })

  it('keeps the pending ID and never debits when funds are insufficient',()=>{
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T08:00:00Z'))
    const db=open(file())
    setup(db)
    const cycleId=due(db)
    const payout=db.prepareCleanerPayout(cycleId)
    expect(()=>db.addCashOperation('withdrawal',payout.amountMinor,'cleaner',payout.id))
      .toThrow('Недостаточно наличных')
    expect(db.getWorkplaceData().cleaner).toMatchObject({
      cycleId,payoutId:payout.id,payoutState:'withdrawal_pending',
    })
    expect(db.listCashOperations().filter((item)=>item.type==='withdrawal')).toHaveLength(0)
    db.addCashOperation('deposit',500000,'float')
    expect(db.addCashOperation('withdrawal',payout.amountMinor,'cleaner',payout.id).cleaningPayoutId).toBe(payout.id)
  })

  it('reconciles a crash after standard cash persistence without another debit',()=>{
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T08:00:00Z'))
    const path=file()
    let db=open(path)
    setup(db)
    vi.setSystemTime(new Date('2026-09-01T08:01:00Z'))
    db.addCashOperation('deposit',500000,'float')
    const payout=db.prepareCleanerPayout(due(db))
    const expectedBefore=db.getShiftSummary().expectedCashMinor
    ;(db as any).reconcileCleaningPayout=()=>{throw new Error('simulated crash')}
    expect(()=>db.addCashOperation('withdrawal',payout.amountMinor,'cleaner',payout.id))
      .toThrow('simulated crash')
    expect(db.listCashOperations().filter((item)=>item.type==='withdrawal')).toHaveLength(1)
    db.close();databases.splice(databases.indexOf(db),1)
    db=open(path)
    expect(db.getWorkplaceData().cleaner.payoutState).toBe('not_due')
    expect(db.getShiftSummary().expectedCashMinor).toBe(expectedBefore-payout.amountMinor)
    const first=db.listCashOperations().find((item)=>item.type==='withdrawal')!
    expect(db.addCashOperation('withdrawal',payout.amountMinor,'cleaner',payout.id).id).toBe(first.id)
    expect(db.listCashOperations().filter((item)=>item.type==='withdrawal')).toHaveLength(1)
  })

  it('rejects a payout reference from another point',()=>{
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T08:00:00Z'))
    const db=open(file())
    setup(db,1,200000)
    db.addCashOperation('deposit',300000,'float')
    const payout=db.prepareCleanerPayout(due(db,1))
    db.setState('bootstrap',JSON.stringify({
      pointId:'POINT-B',workplaceId:'POS-B',pointTimezone:'Europe/Moscow',
      cleaning:{everyNVisits:1,payoutAmountMinor:200000},
    }))
    expect(()=>db.addCashOperation('withdrawal',200000,'wrong point',payout.id)).toThrow('другой точке')
    expect(db.listCashOperations().filter((item)=>item.type==='withdrawal')).toHaveLength(0)
  })
})
