import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BankingEvidence, CompleteSaleRequest, CreateReturnRequest } from '../shared/contracts'
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
  refundRequests:PaymentRequest[]=[]
  statusCalls=0
  nextCharge:PaymentResult={status:'approved',transactionId:'bank-1'}
  nextRefund:PaymentResult={status:'approved',transactionId:'refund-1'}
  nextStatus:PaymentResult={status:'approved',transactionId:'bank-1'}
  throwOnCharge=false

  getAttemptContext(){return {provider:'inpas' as const,adapter:'direct' as const,terminalId:'40000037'}}
  async healthCheck():Promise<DeviceHealth>{return {ready:true,status:'ready',message:'test'}}
  async charge(_request:PaymentRequest):Promise<PaymentResult>{
    this.chargeCalls++
    if(this.throwOnCharge)throw new Error('connection lost')
    return this.nextCharge
  }
  async refund(request:PaymentRequest):Promise<PaymentResult>{
    this.refundCalls++;this.refundRequests.push(request);return this.nextRefund
  }
  async getOperationStatus(_request:PaymentRequest):Promise<PaymentResult>{this.statusCalls++;return this.nextStatus}
  async testConnection(){return {message:'test'}}
  async reconcile(){return {message:'test'}}
}

class TestFiscalProvider implements FiscalProvider {
  saleCalls=0
  returnCalls=0
  statusCalls=0
  snapshotCalls=0
  throwOnSnapshot=false
  throwOnSnapshotAfter=false
  throwOnSale=false
  nextStatus:FiscalOperationStatus={status:'fiscalized',receiptNumber:'FD-recovered'}
  async captureRecoverySnapshot(){this.snapshotCalls++;if(this.throwOnSnapshot||(this.throwOnSnapshotAfter&&this.snapshotCalls>1))throw new Error('snapshot unavailable');return {kktSerialNumber:'KKT-1',shiftNumber:'5',fiscalDocumentNumber:'10',kktDateTime:'2026-09-19T10:00:00.000Z',documentClosed:true}}
  async healthCheck():Promise<DeviceHealth>{return {ready:true,status:'ready',message:'test'}}
  async getShiftStatus(){return {open:true,state:'opened' as const,message:'open'}}
  async openShift(){return}
  async closeShift(){return {message:'closed'}}
  async fiscalizeSale(_request:FiscalRequest):Promise<FiscalResult>{this.saleCalls++;if(this.throwOnSale)throw new Error('timeout');return {receiptNumber:`FD-${this.saleCalls}`}}
  async fiscalizeReturn(_request:FiscalReturnRequest):Promise<FiscalResult>{this.returnCalls++;return {receiptNumber:`FR-${this.returnCalls}`}}
  async getOperationStatus(_request:{
    operationId:string;entityId:string;kind:'sale'|'return';expectedAmountMinor:number;recovery?:unknown
  }):Promise<FiscalOperationStatus>{
    this.statusCalls++;return this.nextStatus
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

  it('does not accept remote payment without explicit cashier confirmation',async()=>{
    await expect(engine.completeSale(request([{method:'remote_payment',amountMinor:2000}],'remote-unconfirmed'),shiftId))
      .rejects.toThrow(/не подтверждена/)
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

  it('persists direct banking evidence before allowing fiscalization',async()=>{
    payment.nextCharge={
      status:'approved',
      transactionId:'TRX-1',
      bankingEvidence:{
        provider:'inpas',adapter:'direct',terminalId:'40000037',
        referenceNumber:'RRN-1',terminalTransactionId:'TRX-1',authorizationCode:'AUTH-1',
        responseCode:'00',transactionStatus:'APPROVED',amountMinor:2000,
        operationKind:'sale',startedAt:'2026-09-19T10:00:00.000Z',
        completedAt:'2026-09-19T10:00:05.000Z'
      }
    }

    const completed=await engine.completeSale(
      request([{method:'card',amountMinor:2000}],'banking-evidence'),shiftId
    )
    const sale=database.getSale(completed.saleId)
    const operation=journal.getByClientRequestId('banking-evidence')!
    const attempt=journal.getLatestPaymentAttempt(operation.id)

    expect(sale.payments[0]).toMatchObject({
      transactionId:'TRX-1',
      bankingEvidence:{referenceNumber:'RRN-1',terminalId:'40000037'}
    })
    expect(attempt).toMatchObject({
      provider:'inpas',adapter:'direct',terminalId:'40000037',
      referenceNumber:'RRN-1',terminalTransactionId:'TRX-1',requestHash:expect.any(String)
    })
    expect(fiscal.saleCalls).toBe(1)
  })

  it('keeps a local attempt id separate when the bank returns no reference',async()=>{
    payment.nextCharge={
      status:'approved',
      bankingEvidence:{
        provider:'inpas',adapter:'direct',terminalId:'40000037',
        responseCode:'00',transactionStatus:'APPROVED',amountMinor:2000,
        operationKind:'sale',startedAt:'2026-09-19T10:00:00.000Z',
        completedAt:'2026-09-19T10:00:05.000Z'
      }
    }

    const completed=await engine.completeSale(
      request([{method:'card',amountMinor:2000}],'banking-no-reference'),shiftId
    )
    const paymentPart=database.getSale(completed.saleId).payments[0]

    expect(paymentPart.transactionId).toBeUndefined()
    expect(paymentPart.bankingEvidence).toMatchObject({
      terminalId:'40000037',responseCode:'00',operationKind:'sale'
    })
    expect(fiscal.saleCalls).toBe(1)
  })

  it('treats an explicitly declined card payment as terminal without blocking the next sale',async()=>{
    payment.nextCharge={status:'declined',message:'Недостаточно средств'}
    await expect(engine.completeSale(request([{method:'card',amountMinor:2000}],'declined-card'),shiftId)).rejects.toThrow(/Недостаточно средств/)
    expect(payment.chargeCalls).toBe(1)
    expect(fiscal.saleCalls).toBe(0)
    expect(engine.listUnresolved()).toHaveLength(0)
    expect(engine.hasBlockingOperation()).toBe(false)

    payment.nextCharge={status:'approved',transactionId:'bank-next'}
    const next=await engine.completeSale(request([{method:'card',amountMinor:2000}],'next-card'),shiftId)
    expect(next.saleId).toBeTruthy()
    expect(payment.chargeCalls).toBe(2)
    expect(fiscal.saleCalls).toBe(1)
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

  const evidence=(referenceNumber:string,amountMinor:number):BankingEvidence=>({
    provider:'inpas',adapter:'direct',terminalId:'40000037',referenceNumber,
    terminalTransactionId:`TRX-${referenceNumber}`,authorizationCode:'AUTH-1',
    responseCode:'00',transactionStatus:'APPROVED',amountMinor,operationKind:'sale',
    startedAt:'2026-09-19T10:00:00.000Z',completedAt:'2026-09-19T10:00:05.000Z'
  })

  const returnRequest=(saleId:string,lineId:number,payments:CreateReturnRequest['payments'],quantity=1):CreateReturnRequest=>({
    clientRequestId:`return-${saleId}-${quantity}-${payments.map((x)=>x.method).join('-')}`,
    saleId,
    lines:[{saleItemId:lineId,quantity}],
    payments
  })

  it('passes original sale evidence to Refund before fiscal return',async()=>{
    payment.nextCharge={
      status:'approved',transactionId:'TRX-RRN-SALE',
      bankingEvidence:evidence('RRN-SALE',2000)
    }
    const completed=await engine.completeSale(
      request([{method:'card',amountMinor:2000}],'sale-for-refund'),shiftId
    )
    const sale=database.getSale(completed.saleId)
    payment.nextRefund={
      status:'approved',transactionId:'TRX-REFUND',
      bankingEvidence:{
        ...evidence('RRN-REFUND',1000),operationKind:'refund',amountMinor:1000,
        originalReferenceNumber:'RRN-SALE',originalTerminalTransactionId:'TRX-RRN-SALE'
      }
    }

    await engine.createReturn(
      returnRequest(sale.id,sale.lines[0].id,[{method:'card',amountMinor:1000}],0.5),
      shiftId,1000,sale
    )

    expect(payment.refundCalls).toBe(1)
    expect(payment.refundRequests[0].originalPayment).toMatchObject({
      amountMinor:2000,
      bankingEvidence:{terminalId:'40000037',referenceNumber:'RRN-SALE'}
    })
    expect(fiscal.returnCalls).toBe(1)
  })

  it('blocks missing or ambiguous original evidence before bank and KKT',async()=>{
    database.saveSale({
      id:'sale-ambiguous',clientRequestId:'sale-ambiguous-request',shiftId,totalMinor:2000,
      paymentMethod:'card',fiscalNumber:'FD-AMB',createdAt:'2026-09-19T11:00:00.000Z',
      receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
      payments:[
        {method:'card',amountMinor:1000,bankingEvidence:evidence('RRN-A',1000)},
        {method:'card',amountMinor:1000,bankingEvidence:evidence('RRN-B',1000)}
      ]
    })
    const ambiguous=database.getSale('sale-ambiguous')
    await expect(engine.createReturn(
      returnRequest(ambiguous.id,ambiguous.lines[0].id,[{method:'card',amountMinor:1000}],0.5),
      shiftId,1000,ambiguous
    )).rejects.toThrow(/однозначно/)
    expect(payment.refundCalls).toBe(0)
    expect(fiscal.returnCalls).toBe(0)

    database.saveSale({
      id:'sale-no-evidence',clientRequestId:'sale-no-evidence-request',shiftId,totalMinor:2000,
      paymentMethod:'card',fiscalNumber:'FD-OLD',createdAt:'2026-09-19T11:10:00.000Z',
      receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
      payments:[{method:'card',amountMinor:2000,transactionId:'legacy-id'}]
    })
    const oldSale=database.getSale('sale-no-evidence')
    await expect(engine.createReturn(
      returnRequest(oldSale.id,oldSale.lines[0].id,[{method:'card',amountMinor:2000}]),
      shiftId,2000,oldSale
    )).rejects.toThrow(/ReferenceNumber\/RRN/)
    expect(payment.refundCalls).toBe(0)
    expect(fiscal.returnCalls).toBe(0)
  })

  it('supports mixed partial return and enforces remaining bank amount',async()=>{
    database.saveSale({
      id:'sale-mixed',clientRequestId:'sale-mixed-request',shiftId,totalMinor:2000,
      paymentMethod:'mixed',fiscalNumber:'FD-MIX',createdAt:'2026-09-19T12:00:00.000Z',
      receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
      payments:[
        {method:'cash',amountMinor:1000,transactionId:'cash-1'},
        {method:'card',amountMinor:1000,bankingEvidence:evidence('RRN-MIX',1000)}
      ]
    })
    let sale=database.getSale('sale-mixed')
    payment.nextRefund={
      status:'approved',transactionId:'TRX-REF-MIX',
      bankingEvidence:{
        ...evidence('RRN-REF-MIX',500),operationKind:'refund',amountMinor:500,
        originalReferenceNumber:'RRN-MIX'
      }
    }
    await engine.createReturn(
      returnRequest(sale.id,sale.lines[0].id,[
        {method:'cash',amountMinor:500},{method:'card',amountMinor:500}
      ],0.5),
      shiftId,1000,sale
    )
    expect(payment.refundCalls).toBe(1)
    expect(fiscal.returnCalls).toBe(1)

    sale=database.getSale('sale-mixed')
    await expect(engine.createReturn({
      clientRequestId:'return-over-bank-balance',saleId:sale.id,
      lines:[{saleItemId:sale.lines[0].id,quantity:0.25}],
      payments:[{method:'card',amountMinor:600}]
    },shiftId,600,sale)).rejects.toThrow(/доступный остаток/)
    expect(payment.refundCalls).toBe(1)
    expect(fiscal.returnCalls).toBe(1)
  })

  it('never fiscalizes a return after declined or unknown bank result',async()=>{
    database.saveSale({
      id:'sale-declined-return',clientRequestId:'sale-declined-return-request',shiftId,totalMinor:2000,
      paymentMethod:'card',fiscalNumber:'FD-DECL',createdAt:'2026-09-19T13:00:00.000Z',
      receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
      payments:[{method:'card',amountMinor:2000,bankingEvidence:evidence('RRN-DECL',2000)}]
    })
    const sale=database.getSale('sale-declined-return')
    payment.nextRefund={status:'declined',message:'REFUND DECLINED'}
    await expect(engine.createReturn(
      returnRequest(sale.id,sale.lines[0].id,[{method:'card',amountMinor:2000}]),
      shiftId,2000,sale
    )).rejects.toThrow(/DECLINED/)
    expect(fiscal.returnCalls).toBe(0)

    database.saveSale({
      id:'sale-unknown-return',clientRequestId:'sale-unknown-return-request',shiftId,totalMinor:2000,
      paymentMethod:'card',fiscalNumber:'FD-UNKNOWN',createdAt:'2026-09-19T13:10:00.000Z',
      receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:2000}],
      payments:[{method:'card',amountMinor:2000,bankingEvidence:evidence('RRN-UNKNOWN',2000)}]
    })
    const unknownSale=database.getSale('sale-unknown-return')
    payment.nextRefund={status:'unknown',message:'REFUND STATUS UNKNOWN'}
    await expect(engine.createReturn(
      returnRequest(unknownSale.id,unknownSale.lines[0].id,[{method:'card',amountMinor:2000}]),
      shiftId,2000,unknownSale
    )).rejects.toThrow(/НЕ повторяйте/)
    expect(fiscal.returnCalls).toBe(0)
    expect(payment.refundCalls).toBe(2)

    const unresolved=engine.listUnresolved().find((operation)=>operation.entityId!==sale.id)!
    payment.nextStatus={status:'unknown',message:'REFUND STILL UNKNOWN'}
    expect((await engine.recover(unresolved.id)).status).toBe('attention')
    expect(payment.refundCalls).toBe(2)
    expect(payment.statusCalls).toBe(1)
    expect(fiscal.returnCalls).toBe(0)
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

  it('does not start fiscalization when the pre-call snapshot is unavailable',async()=>{
    fiscal.throwOnSnapshot=true
    await expect(engine.completeSale(request([{method:'cash',amountMinor:2000}],'snapshot-failed'),shiftId))
      .rejects.toThrow('snapshot unavailable')
    expect(fiscal.saleCalls).toBe(0)
    const unresolved=engine.listUnresolved()[0]
    expect(unresolved.state).toBe('payment_confirmed')
    expect(journal.getLatestFiscalAttempt(unresolved.id)).toBeNull()
  })

  it('keeps a proven fiscal result when the post-call snapshot fails',async()=>{
    fiscal.throwOnSnapshotAfter=true
    const completed=await engine.completeSale(request([{method:'cash',amountMinor:2000}],'post-snapshot-failed'),shiftId)
    expect(completed.saleId).toBeTruthy()
    expect(fiscal.saleCalls).toBe(1)
    expect(fiscal.snapshotCalls).toBe(2)
    expect(engine.listUnresolved()).toHaveLength(0)
  })

  it('keeps a timed-out fiscal attempt unknown and never fiscalizes it again without proof',async()=>{
    fiscal.throwOnSale=true
    await expect(engine.completeSale(request([{method:'cash',amountMinor:2000}],'fiscal-timeout'),shiftId))
      .rejects.toThrow(/НЕ пробивайте чек повторно/)
    expect(fiscal.saleCalls).toBe(1)
    expect(engine.listUnresolved()[0].state).toBe('fiscal_status_unknown')
    expect(journal.getLatestFiscalAttempt(engine.listUnresolved()[0].id)?.requestHash).toBeTruthy()

    fiscal.throwOnSale=false
    fiscal.nextStatus={status:'unknown',message:'ФН не даёт однозначного доказательства'}
    const recovery=await engine.recover(engine.listUnresolved()[0].id)
    expect(recovery.status).toBe('attention')
    expect(fiscal.statusCalls).toBe(1)
    expect(fiscal.saleCalls).toBe(1)
    expect(engine.listUnresolved()[0].state).toBe('fiscal_status_unknown')
  })

})
