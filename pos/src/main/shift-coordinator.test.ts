import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  DeviceHealth, FiscalOperationStatus, FiscalProvider, FiscalRequest, FiscalResult,
  FiscalReturnRequest, FiscalShiftStatus
} from './providers/contracts'
import { PosDatabase } from './database'
import { ShiftCoordinator } from './shift-coordinator'

class ShiftFiscalProvider implements FiscalProvider {
  state:FiscalShiftStatus['state']='opened'
  failClose=false
  lastOpenOperator?:string
  lastCloseOperator?:string

  async healthCheck():Promise<DeviceHealth>{
    return this.state==='expired'
      ?{ready:false,status:'error',message:'expired'}
      :{ready:true,status:'ready',message:'ok'}
  }
  async getShiftStatus():Promise<FiscalShiftStatus>{
    return this.state==='closed'
      ?{open:false,state:'closed',message:'closed'}
      :this.state==='expired'
        ?{open:true,state:'expired',message:'expired'}
        :{open:true,state:'opened',message:'open'}
  }
  async openShift(operatorName?:string){this.lastOpenOperator=operatorName;this.state='opened'}
  async closeShift(operatorName?:string){
    this.lastCloseOperator=operatorName
    if(this.failClose)throw new Error('ККТ недоступна')
    this.state='closed'
    return {message:'closed'}
  }
  async fiscalizeSale(_request:FiscalRequest):Promise<FiscalResult>{return {receiptNumber:'1'}}
  async fiscalizeReturn(_request:FiscalReturnRequest):Promise<FiscalResult>{return {receiptNumber:'2'}}
  async getOperationStatus():Promise<FiscalOperationStatus>{return {status:'not_found'}}
  async reprintReceipt(){return {kind:'fiscal-copy' as const,status:'printed' as const,message:'ok'}}
}

describe('ShiftCoordinator recovery',()=>{
  let dir:string
  let database:PosDatabase
  let fiscal:ShiftFiscalProvider
  let coordinator:ShiftCoordinator

  beforeEach(()=>{
    dir=mkdtempSync(join(tmpdir(),'raspechatka-shift-test-'))
    database=new PosDatabase(join(dir,'pos.sqlite'))
    fiscal=new ShiftFiscalProvider()
    coordinator=new ShiftCoordinator(database,fiscal)
  })

  afterEach(()=>{
    database.close();rmSync(dir,{recursive:true,force:true})
  })

  it('does not recreate an employee shift from an already-open ATOL shift',async()=>{
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'open',shiftId:'shift-recovered',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир',startedAt:'2026-09-10T08:00:00.000Z'
    }))
    fiscal.state='opened'

    const result=await coordinator.recoverPendingTransition()

    expect(result.recovered).toBe(true)
    expect(database.currentShift()).toBeNull()
    expect(database.getState('fiscal_shift_transition_v1')).toBe('')
  })

  it('keeps an already-closed employee shift closed when ATOL was also closed',async()=>{
    database.openShift({id:'shift-open',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир'})
    database.closeShift()
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'close',shiftId:'shift-open',startedAt:'2026-09-10T18:00:00.000Z'
    }))
    fiscal.state='closed'

    const result=await coordinator.recoverPendingTransition()

    expect(result.recovered).toBe(true)
    expect(database.currentShift()).toBeNull()
    expect(database.getState('fiscal_shift_transition_v1')).toBe('')
  })

  it('does not invent a completed employee shift when ATOL is still closed',async()=>{
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'open',shiftId:'shift-failed',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир',startedAt:'2026-09-10T08:00:00.000Z'
    }))
    fiscal.state='closed'

    const result=await coordinator.recoverPendingTransition()

    expect(result.recovered).toBe(false)
    expect(database.currentShift()).toBeNull()
    expect(database.getState('fiscal_shift_transition_v1')).toBe('')
  })

  it('drops a stale ATOL-open transition when no employee shift exists',async()=>{
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'open',shiftId:'shift-expired',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир',startedAt:'2026-09-10T08:00:00.000Z'
    }))
    fiscal.state='expired'

    const result=await coordinator.recoverPendingTransition()

    expect(result.pending).toBe(false)
    expect(database.currentShift()).toBeNull()
    expect(database.getState('fiscal_shift_transition_v1')).toBe('')
  })

  it('allows closing an employee shift even when ATOL shift is expired',async()=>{
    database.openShift({id:'shift-open',openedAt:'2026-09-09T08:00:00.000Z',cashierName:'Кассир'})
    fiscal.state='expired'

    await coordinator.closeShift(false)

    expect(fiscal.state).toBe('closed')
    expect(database.currentShift()).toBeNull()
  })

  it('returns an already-open employee shift even when ATOL needs service',async()=>{
    database.openShift({id:'shift-open',openedAt:'2026-09-09T08:00:00.000Z',cashierName:'Кассир'})
    fiscal.state='expired'

    const shift=await coordinator.openShift('Кассир')

    expect(shift.id).toBe('shift-open')
    expect(database.currentShift()?.id).toBe('shift-open')
  })

  it('preserves the cashier name when KKT close is recovered after POS restart',async()=>{
    database.openShift({
      id:'shift-restart',openedAt:'2026-09-18T08:00:00.000Z',
      cashierId:'employee-1',cashierName:'Мария Иванова'
    })
    fiscal.state='opened'
    fiscal.failClose=true

    await coordinator.closeShift(false)

    const pending=JSON.parse(database.getState('fiscal_shift_transition_v1')||'{}')
    expect(pending.cashierName).toBe('Мария Иванова')
    expect(database.currentShift()).toBeNull()

    database.close()
    database=new PosDatabase(join(dir,'pos.sqlite'))
    fiscal=new ShiftFiscalProvider()
    fiscal.state='opened'
    coordinator=new ShiftCoordinator(database,fiscal)

    const result=await coordinator.recoverPendingTransition()

    expect(result.recovered).toBe(true)
    expect(result.pending).toBe(false)
    expect(fiscal.lastCloseOperator).toBe('Мария Иванова')
    expect(database.getState('fiscal_shift_transition_v1')).toBe('')
  })
})
