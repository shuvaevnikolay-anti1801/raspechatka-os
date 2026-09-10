import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CompleteSaleRequest } from '../shared/contracts'
import type {
  DeviceHealth, FiscalOperationStatus, FiscalProvider, FiscalRequest, FiscalResult,
  FiscalReturnRequest, PaymentProvider, PaymentRequest, PaymentResult
} from './providers/contracts'
import { PosDatabase } from './database'
import { TransactionJournal } from './transaction-journal'
import { PosTransactionEngine } from './transaction-engine'

class TestPaymentProvider implements PaymentProvider {
  chargeCalls=0
  refundCalls=0
  statusCalls=0
  nextCharge:PaymentResult={status:'approved',transactionId:'bank-1'}
  nextStatus:PaymentResult={status:'approved',transactionId:'bank-1'}
  throwOnCharge=false

  async healthCheck():Promise<DeviceHealth>{return {ready:true,status:'ready',message:'test'}}
  async charge(_request:PaymentRequest):Promise<PaymentResult>{
    this.chargeCalls++
    if(this.throwOnCharge)throw new Error('connection lost')
    return this.nextCharge
  }
  async refund(_request:PaymentRequest):Promise<PaymentResult>{this.refundCalls++;return this.nextCharge}
  async getOperationStatus(_request:PaymentRequest):Promise<PaymentResult>{this.statusCalls++;return this.nextStatus}
}

class TestFiscalProvider implements FiscalProvider {
  saleCalls=0
  returnCalls=0
  statusCalls=0
  async healthCheck():Promise<DeviceHealth>{return {ready:true,status:'ready',message:'test'}}
  async getShiftStatus(){return {open:true,message:'open'}}
  async openShift(){return}
  async closeShift(){return {message:'closed'}}
  async fiscalizeSale(_request:FiscalRequest):Promise<FiscalResult>{this.saleCalls++;return {receiptNumber:`FD-${this.saleCalls}`}}
  async fiscalizeReturn(_request:FiscalReturnRequest):Promise<FiscalResult>{this.returnCalls++;return {receiptNumber:`FR-${this.returnCalls}`}}
  async getOperationStatus(_request:{operationId:string;entityId:string;kind:'sale'|'return';expectedAmountMinor:number}):Promise<FiscalOperationStatus>{
    this.statusCalls++;return {status:'fiscalized',receiptNumber:'FD-recovered'}
  }
  async reprintReceipt(){return {kind:'fiscal-copy' as const,status:'printed' as const,message:'ok'}}
}

describe('PosTransactionEngine safety',()=>{
  let dir:string
  let database:PosDatabase
  let journal:TransactionJournal
  let payment:TestPaymentProvider
  let fiscal:TestFiscalProvider
  let engine:PosTransactionEngine
  let shiftId:string

  beforeEach(()=>{
    dir=mkdtempSync(join(tmpdir(),'raspechatka-pos-test-'))
    database=new PosDatabase(join(dir,'pos.sqlite'))
    journal=new TransactionJournal(join(dir,'journal.sqlite'))
    payment=new TestPaymentProvider()
    fiscal=new TestFiscalProvider()
    engine=new PosTransactionEngine(database,journal,payment,fiscal)
    shiftId='shift-test'
    database.openShift({id:shiftId,openedAt:new Date().toISOString(),cashierName:'Тест'})
  })

  afterEach(()=>{
    journal.close();database.close();rmSync(dir,{recursive:true,force:true})
  })

  const request=(payments:CompleteSaleRequest['payments'],clientRequestId='request-1'):CompleteSaleRequest=>({
    clientRequestId,
    lines:[{productId:'print-bw-a4',name:'Печать ч/б A4',quantity:1,unitPriceMinor:2000,discountPercent:0}],
    payments
  })

  it('rejects payment total mismatch before touching bank or fiscal device',async()=>{
    await expect(engine.completeSale(request([{method:'card',amountMinor:1900}]),shiftId)).rejects.toThrow(/не совпадает/)
    expect(payment.chargeCalls).toBe(0)
    expect(fiscal.saleCalls).toBe(0)
    expect(engine.listUnresolved()).toHaveLength(0)
  })

  it('persists unknown bank state and recovers without a second charge',async()=>{
    payment.throwOnCharge=true
    await expect(engine.completeSale(request([{method:'card',amountMinor:2000}]),shiftId)).rejects.toThrow(/НЕ повторяйте оплату/)
    expect(payment.chargeCalls).toBe(1)
    expect(fiscal.saleCalls).toBe(0)
    const unresolved=engine.listUnresolved()
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0].state).toBe('payment_unknown')

    payment.throwOnCharge=false
    payment.nextStatus={status:'approved',transactionId:'bank-recovered'}
    const result=await engine.recover(unresolved[0].id)
    expect(result.status).toBe('completed')
    expect(payment.chargeCalls).toBe(1)
    expect(payment.statusCalls).toBe(1)
    expect(fiscal.saleCalls).toBe(1)
    expect(engine.listUnresolved()).toHaveLength(0)
  })

  it('keeps confirmed first part of mixed payment during recovery',async()=>{
    payment.throwOnCharge=true
    await expect(engine.completeSale(request([
      {method:'cash',amountMinor:500},
      {method:'card',amountMinor:1500}
    ]),shiftId)).rejects.toThrow(/НЕ повторяйте оплату/)

    const unresolved=engine.listUnresolved()
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0].paymentMethods).toEqual(['cash'])
    expect(payment.chargeCalls).toBe(1)

    payment.throwOnCharge=false
    payment.nextStatus={status:'approved',transactionId:'card-recovered'}
    const recovery=await engine.recover(unresolved[0].id)
    expect(recovery.status).toBe('completed')
    expect(payment.chargeCalls).toBe(1)
    expect(fiscal.saleCalls).toBe(1)
    expect(database.getSale(database.listSales()[0].id).payments.map((x)=>x.method)).toEqual(['cash','card'])
  })

  it('stores manual remote payment confirmation without calling the terminal',async()=>{
    const remoteRequest:CompleteSaleRequest={
      ...request([{method:'remote_payment',amountMinor:2000}],'remote-request'),
      remotePaymentConfirmation:{
        confirmed:true,
        confirmedAt:'2026-09-10T12:00:00.000Z',
        confirmedBy:'Кассир',
        note:'Проверено по подтверждению клиента'
      }
    }

    const completed=await engine.completeSale(remoteRequest,shiftId)
    const sale=database.getSale(completed.saleId)

    expect(payment.chargeCalls).toBe(0)
    expect(fiscal.saleCalls).toBe(1)
    expect(sale.payments[0].method).toBe('remote_payment')
    expect(sale.remotePaymentConfirmation?.confirmedBy).toBe('Кассир')
    expect(database.getShiftSummary().remotePaymentMinor).toBe(2000)
  })

  it('auto-finishes a fiscalized operation locally without touching money or KKT again',async()=>{
    const savedRequest=request([{method:'cash',amountMinor:2000}],'crash-after-fiscal')
    const operation=journal.create({
      id:'operation-crash',clientRequestId:savedRequest.clientRequestId,kind:'sale',entityId:'sale-crash',
      shiftId,amountMinor:2000,request:savedRequest,createdAt:'2026-09-10T12:00:00.000Z'
    })
    journal.setConfirmedPayments(operation.id,[{method:'cash',amountMinor:2000,transactionId:'CASH-sale-crash-0'}])
    journal.setFiscalReceipt(operation.id,'FD-ALREADY-PRINTED')
    journal.setState(operation.id,'fiscalized')

    const recovered=await engine.recoverSafeOperations()

    expect(recovered).toBe(1)
    expect(payment.chargeCalls).toBe(0)
    expect(fiscal.saleCalls).toBe(0)
    expect(database.findSaleByClientRequestId(savedRequest.clientRequestId)?.receiptNumber).toBe('FD-ALREADY-PRINTED')
    expect(engine.listUnresolved()).toHaveLength(0)
  })

  it('repairs a stale journal if the sale was already committed locally',async()=>{
    const completed=await engine.completeSale(request([{method:'cash',amountMinor:2000}]),shiftId)
    expect(completed.saleId).toBeTruthy()
    expect(fiscal.saleCalls).toBe(1)
    expect(engine.listUnresolved()).toHaveLength(0)
  })
})
