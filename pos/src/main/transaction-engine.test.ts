import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { calculateDiscountBreakdown } from '../shared/cart'
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
  charges:PaymentRequest[]=[]
  refundCalls=0
  statusCalls=0
  nextCharge:PaymentResult={status:'approved',transactionId:'bank-1'}
  nextStatus:PaymentResult={status:'approved',transactionId:'bank-1'}
  throwOnCharge=false

  async healthCheck():Promise<DeviceHealth>{return {ready:true,status:'ready',message:'test'}}
  async charge(_request:PaymentRequest):Promise<PaymentResult>{
    this.charges.push(_request)
    this.chargeCalls++
    if(this.throwOnCharge)throw new Error('connection lost')
    return this.nextCharge
  }
  async refund(_request:PaymentRequest):Promise<PaymentResult>{this.refundCalls++;return this.nextCharge}
  async getOperationStatus(_request:PaymentRequest):Promise<PaymentResult>{this.statusCalls++;return this.nextStatus}
  async testConnection(){return {message:'test'}}
  async reconcile(){return {message:'test'}}
}

class TestFiscalProvider implements FiscalProvider {
  saleCalls=0
  sales:FiscalRequest[]=[]
  returnCalls=0
  returns:FiscalReturnRequest[]=[]
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
  async fiscalizeSale(_request:FiscalRequest):Promise<FiscalResult>{this.sales.push(_request);this.saleCalls++;if(this.throwOnSale)throw new Error('timeout');return {receiptNumber:`FD-${this.saleCalls}`}}
  async fiscalizeReturn(_request:FiscalReturnRequest):Promise<FiscalResult>{this.returns.push(_request);this.returnCalls++;return {receiptNumber:`FR-${this.returnCalls}`}}
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

  it('creates a paid production order only after the sale is fiscalized',async()=>{
    const withOrder:CompleteSaleRequest={
      ...request([{method:'cash',amountMinor:2000}],'sale-with-order'),
      order:{phone:'+7 900 123-45-67',comment:'Напечатать комплект',dueAt:'2026-09-21T12:00:00.000Z'}
    }
    const completed=await engine.completeSale(withOrder,shiftId)
    expect(fiscal.saleCalls).toBe(1)
    expect(completed.order).toMatchObject({
      status:'in_progress',paymentStatus:'paid',paidMinor:2000,sourceSaleId:completed.saleId
    })
    expect(database.listOrders()).toHaveLength(1)
  })

  it('does not create an order when fiscalization is unresolved',async()=>{
    fiscal.throwOnSale=true
    const withOrder:CompleteSaleRequest={
      ...request([{method:'cash',amountMinor:2000}],'failed-sale-with-order'),
      order:{phone:'+7 900 123-45-67',comment:'Не должен появиться',dueAt:'2026-09-21T12:00:00.000Z'}
    }
    await expect(engine.completeSale(withOrder,shiftId)).rejects.toThrow(/НЕ пробивайте чек повторно/)
    expect(database.listOrders()).toHaveLength(0)
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

  const roundedRequest=(payments:CompleteSaleRequest['payments'],id:string):CompleteSaleRequest=>{
    const lines=[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:299}]
    const discountRules={allowDiscounts:false,maxDiscountPercent:0,reviewDiscountPerReviewMinor:0}
    return {
      clientRequestId:id,lines,payments,discountRules,
      discountBreakdown:calculateDiscountBreakdown(lines,discountRules),
      payableMinor:200,
    }
  }

  it.each([
    ['card',[{method:'card' as const,amountMinor:200}]],
    ['cash',[{method:'cash' as const,amountMinor:200}]],
    ['qr',[{method:'qr' as const,amountMinor:200}]],
    ['remote_payment',[{method:'remote_payment' as const,amountMinor:200}]],
    ['mixed',[{method:'cash' as const,amountMinor:50},{method:'card' as const,amountMinor:150}]],
  ])('persists one payable for %s across payment, journal, fiscal and sale',async(method,parts)=>{
    const input=roundedRequest(parts,'rounded-'+method)
    if(method==='remote_payment')input.remotePaymentConfirmation={
      confirmed:true,confirmedAt:'2026-09-10T12:00:00.000Z'
    }
    if(method==='cash')input.cashReceivedMinor=300
    const result=await engine.completeSale(input,shiftId)
    const operation=journal.getByClientRequestId(input.clientRequestId)!
    expect(operation.amountMinor).toBe(200)
    expect((operation.request as CompleteSaleRequest).discountBreakdown).toMatchObject({
      totalMinor:299,roundingAdjustmentMinor:99,payableMinor:200,
    })
    expect(operation.confirmedPayments.reduce((sum,p)=>sum+p.amountMinor,0)).toBe(200)
    expect(payment.charges.map((p)=>p.amountMinor)).toEqual(parts.filter(p=>p.method!=='cash'&&p.method!=='remote_payment').map(p=>p.amountMinor))
    expect(fiscal.sales[0].amountMinor).toBe(200)
    expect(result.totalMinor).toBe(200)
    expect(database.getSale(result.saleId).payments.reduce((sum,p)=>sum+p.amountMinor,0)).toBe(200)
    expect(result.changeMinor).toBe(method==='cash'?100:0)
  })

  it('rejects mismatched payable, evidence, parts and legacy total before side effects',async()=>{
    const valid=roundedRequest([{method:'card',amountMinor:200}],'invalid-payable')
    await expect(engine.completeSale({...valid,payableMinor:299},shiftId)).rejects.toThrow(/Сумма к оплате/)
    await expect(engine.completeSale({...valid,discountBreakdown:{...valid.discountBreakdown!,roundingAdjustmentMinor:0}},shiftId)).rejects.toThrow(/Расчёт скидок/)
    await expect(engine.completeSale({...valid,payments:[{method:'card',amountMinor:299}]},shiftId)).rejects.toThrow(/не совпадает/)
    await expect(engine.completeSale(valid,shiftId,299)).rejects.toThrow(/Итог чека/)
    expect(payment.chargeCalls).toBe(0)
    expect(fiscal.saleCalls).toBe(0)
    expect(engine.listUnresolved()).toHaveLength(0)
  })

  it('keeps rounded attempt hash and UNKNOWN blocker across journal restart',async()=>{
    const input=roundedRequest([{method:'card',amountMinor:200}],'rounded-unknown')
    payment.throwOnCharge=true
    await expect(engine.completeSale(input,shiftId)).rejects.toThrow(/НЕ повторяйте оплату/)
    const operation=journal.getByClientRequestId(input.clientRequestId)!
    const hash=journal.getLatestPaymentAttempt(operation.id)?.requestHash
    expect(hash).toBeTruthy()
    expect(journal.getLatestPaymentAttempt(operation.id)?.amountMinor).toBe(200)
    journal.close()
    journal=new TransactionJournal(join(dir,'journal.sqlite'))
    engine=new PosTransactionEngine(database,journal,payment,fiscal)
    expect(journal.get(operation.id)?.amountMinor).toBe(200)
    expect(journal.getLatestPaymentAttempt(operation.id)?.requestHash).toBe(hash)
    await expect(engine.completeSale({...input,payableMinor:300},shiftId)).rejects.toThrow(/Сумма к оплате/)
    await expect(engine.completeSale(input,shiftId)).rejects.toThrow(/защиты|провер|восстанов|заверш/)
    expect(payment.chargeCalls).toBe(1)
    expect(fiscal.saleCalls).toBe(0)
  })

  it('uses persisted paid line allocation for full and partial historical returns',async()=>{
    const sale=await engine.completeSale(request([{method:'cash',amountMinor:2000}],'return-source'),shiftId)
    const persisted=database.getSale(sale.saleId)
    const first=persisted.lines[0]
    const partial=await engine.createReturn({
      clientRequestId:'partial-return',saleId:sale.saleId,
      lines:[{saleItemId:first.id,quantity:0.5}],
      payments:[{method:'cash',amountMinor:1000}],
    },shiftId,1000,persisted)
    expect(partial.totalMinor).toBe(1000)
    expect((fiscal.returns[0].lines[0] as typeof fiscal.returns[0].lines[0] & {lineTotalMinor:number}).lineTotalMinor).toBe(1000)
    await expect(engine.createReturn({
      clientRequestId:'over-return',saleId:sale.saleId,
      lines:[{saleItemId:first.id,quantity:0.6}],
      payments:[{method:'cash',amountMinor:1200}],
    },shiftId,1200,database.getSale(sale.saleId))).rejects.toThrow(/доступно|превышает/)
  })


})
