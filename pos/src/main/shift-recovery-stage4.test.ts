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

class RecoveryFiscalProvider implements FiscalProvider {
  state:FiscalShiftStatus['state']='opened'
  failStatus=false

  async healthCheck():Promise<DeviceHealth>{return {ready:true,status:'ready',message:'ok'}}
  async getShiftStatus():Promise<FiscalShiftStatus>{
    if(this.failStatus)throw new Error('ATOL unavailable')
    if(this.state==='closed')return {open:false,state:'closed',message:'closed'}
    if(this.state==='expired')return {open:true,state:'expired',message:'expired'}
    return {open:true,state:'opened',message:'opened'}
  }
  async openShift(){this.state='opened'}
  async closeShift(){this.state='closed';return {message:'closed'}}
  async fiscalizeSale(_request:FiscalRequest):Promise<FiscalResult>{return {receiptNumber:'1'}}
  async fiscalizeReturn(_request:FiscalReturnRequest):Promise<FiscalResult>{return {receiptNumber:'2'}}
  async getOperationStatus():Promise<FiscalOperationStatus>{return {status:'not_found'}}
  async reprintReceipt(){return {kind:'fiscal-copy' as const,status:'printed' as const,message:'ok'}}
}

describe('stage 4 shift recovery',()=>{
  let dir:string
  let database:PosDatabase
  let fiscal:RecoveryFiscalProvider
  let coordinator:ShiftCoordinator

  beforeEach(()=>{
    dir=mkdtempSync(join(tmpdir(),'raspechatka-shift-recovery-'))
    database=new PosDatabase(join(dir,'pos.sqlite'))
    fiscal=new RecoveryFiscalProvider()
    coordinator=new ShiftCoordinator(database,fiscal)
  })

  afterEach(()=>{
    database.close()
    rmSync(dir,{recursive:true,force:true})
  })

  it('keeps fiscal close pending while ATOL status cannot be checked',async()=>{
    database.openShift({id:'shift-1',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир'})
    database.closeShift()
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'close',shiftId:'shift-1',startedAt:'2026-09-10T18:00:00.000Z'
    }))
    fiscal.failStatus=true

    const result=await coordinator.recoverPendingTransition()

    expect(result.pending).toBe(true)
    expect(coordinator.getPendingTransition()?.action).toBe('close')
    expect(database.currentShift()).toBeNull()
  })

  it('finishes fiscal close after ATOL becomes reachable and keeps employee shift closed',async()=>{
    database.openShift({id:'shift-1',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир'})
    database.closeShift()
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'close',shiftId:'shift-1',startedAt:'2026-09-10T18:00:00.000Z'
    }))
    fiscal.state='closed'

    const result=await coordinator.recoverPendingTransition()

    expect(result.recovered).toBe(true)
    expect(result.pending).toBe(false)
    expect(database.currentShift()).toBeNull()
    expect(coordinator.getPendingTransition()).toBeUndefined()
  })

  it('never replaces a different employee shift with recovered ATOL state',async()=>{
    database.openShift({id:'another-shift',openedAt:'2026-09-10T07:00:00.000Z',cashierName:'Другой кассир'})
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'open',shiftId:'shift-from-crash',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир',startedAt:'2026-09-10T08:00:00.000Z'
    }))
    fiscal.state='opened'

    const result=await coordinator.recoverPendingTransition()

    expect(result.recovered).toBe(true)
    expect(result.pending).toBe(false)
    expect(database.currentShift()?.id).toBe('another-shift')
    expect(coordinator.getPendingTransition()).toBeUndefined()
  })
})
