import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  DeviceHealth, FiscalOperationStatus, FiscalProvider, FiscalRequest, FiscalResult,
  FiscalReturnRequest
} from './providers/contracts'
import { PosDatabase } from './database'
import { ShiftCoordinator } from './shift-coordinator'

class ShiftFiscalProvider implements FiscalProvider {
  open=true
  async healthCheck():Promise<DeviceHealth>{return {ready:true,status:'ready',message:'ok'}}
  async getShiftStatus(){return {open:this.open,message:this.open?'open':'closed'}}
  async openShift(){this.open=true}
  async closeShift(){this.open=false;return {message:'closed'}}
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

  it('restores local shift when ATOL opening succeeded before app crash',async()=>{
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'open',shiftId:'shift-recovered',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир',startedAt:'2026-09-10T08:00:00.000Z'
    }))
    fiscal.open=true

    const result=await coordinator.recoverPendingTransition()

    expect(result.recovered).toBe(true)
    expect(database.currentShift()?.id).toBe('shift-recovered')
    expect(database.getState('fiscal_shift_transition_v1')).toBe('')
  })

  it('finishes local close when ATOL was already closed before app crash',async()=>{
    database.openShift({id:'shift-open',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир'})
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'close',shiftId:'shift-open',startedAt:'2026-09-10T18:00:00.000Z'
    }))
    fiscal.open=false

    const result=await coordinator.recoverPendingTransition()

    expect(result.recovered).toBe(true)
    expect(database.currentShift()).toBeNull()
    expect(database.getState('fiscal_shift_transition_v1')).toBe('')
  })

  it('does not invent a completed opening when ATOL is still closed',async()=>{
    database.setState('fiscal_shift_transition_v1',JSON.stringify({
      action:'open',shiftId:'shift-failed',openedAt:'2026-09-10T08:00:00.000Z',cashierName:'Кассир',startedAt:'2026-09-10T08:00:00.000Z'
    }))
    fiscal.open=false

    const result=await coordinator.recoverPendingTransition()

    expect(result.recovered).toBe(false)
    expect(database.currentShift()).toBeNull()
    expect(database.getState('fiscal_shift_transition_v1')).toBe('')
  })
})
