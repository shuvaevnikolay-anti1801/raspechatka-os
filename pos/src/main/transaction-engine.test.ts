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
  healthCalls=0
  chargeCalls=0
  charges:PaymentRequest[]=[]
  refundCalls=0
  statusCalls=0
  nextCharge:PaymentResult={status:'approved',transactionId:'bank-1'}
  nextStatus:PaymentResult={status:'approved',transactionId:'bank-1'}
  throwOnCharge=false

  async healthCheck():Promise<DeviceHealth>{this.healthCalls++;return {ready:true,status:'ready',message:'test'}}
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
  ready=true
  throwOnHealth=false
  throwOnShift=false
  shiftOpen=true
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
  async healthCheck():Promise<DeviceHealth>{if(this.throwOnHealth)throw new Error('secret driver failure');return {ready:this.ready,status:this.ready?'ready':'not_available',message:'test'}}
  async getShiftStatus(){if(this.throwOnShift)throw new Error('secret driver failure');return {open:this.shiftOpen,state:this.shiftOpen?'opened' as const:'closed' as const,message:'test'}}
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

  it.each(['disconnected','unconfigured','health error','shift unavailable','shift closed'])(
    'persists a safe, cancellable sale before payment when KKT is %s',async(failure)=>{
      fiscal.ready=failure!=='disconnected'&&failure!=='unconfigured'
      fiscal.throwOnHealth=failure==='health error'
      fiscal.throwOnShift=failure==='shift unavailable'
      fiscal.shiftOpen=failure!=='shift closed'
      await expect(engine.completeSale(request([{method:'card',amountMinor:2000}]),shiftId)).rejects.toThrow(/ККТ|[Фф]искальную смену|[Фф]искальная смена/)
      const unresolved=engine.listUnresolved()
      expect(unresolved).toHaveLength(1)
      expect(unresolved[0]).toMatchObject({state:'created',canCancel:true,paymentMethods:['card'],amountMinor:2000})
      expect(unresolved[0].lastError).not.toContain('secret driver failure')
      expect(payment.healthCalls).toBe(0)
      expect(payment.chargeCalls).toBe(0)
      expect(fiscal.saleCalls).toBe(0)
      expect(journal.getLatestFiscalAttempt(unresolved[0].id)).toBeNull()
      expect(database.findSaleByClientRequestId('request-1')).toBeNull()
      expect(database.findOrderBySourceSale(unresolved[0].entityId)).toBeFalsy()
    }
  )

  it('recovers the same sale once after a journal restart and KKT readiness',async()=>{
    fiscal.ready=false
    const input={...request([{method:'card' as const,amountMinor:2000}],'restart-sale'),
      order:{phone:'+7 999 123-45-67',comment:'Печать плаката',dueAt:'2026-10-01T10:00:00.000Z'}}
    await expect(engine.completeSale(input,shiftId)).rejects.toThrow(/ККТ/)
    const operation=engine.listUnresolved()[0]
    expect(operation.canCancel).toBe(true)
    journal.close()
    journal=new TransactionJournal(join(dir,'journal.sqlite'))
    engine=new PosTransactionEngine(database,journal,payment,fiscal)
    expect(engine.listUnresolved()).toMatchObject([{id:operation.id,state:'created',canCancel:true}])
    fiscal.ready=true
    expect(await engine.recover(operation.id)).toMatchObject({status:'completed'})
    expect(await engine.recover(operation.id)).toMatchObject({status:'completed'})
    expect(payment.chargeCalls).toBe(1)
    expect(fiscal.saleCalls).toBe(1)
    expect(database.findSaleByClientRequestId('restart-sale')).toBeTruthy()
    expect(database.findOrderBySourceSale(operation.entityId)).toBeTruthy()
    expect(engine.listUnresolved()).toHaveLength(0)
  })

  it('cancels pre-effect and evidence-free unknown operations but keeps evidenced or confirmed payments protected',async()=>{
    fiscal.ready=false
    await expect(engine.completeSale(request([{method:'cash',amountMinor:2000}],'cancel-safe'),shiftId)).rejects.toThrow(/ККТ/)
    const operation=engine.listUnresolved()[0]
    expect(engine.cancelBeforeSideEffects(operation.id)).toMatchObject({status:'completed'})
    expect(engine.listUnresolved()).toHaveLength(0)
    fiscal.ready=true
    await expect(engine.recover(operation.id)).resolves.toMatchObject({status:'completed'})
    expect(fiscal.saleCalls).toBe(0)
    await expect(engine.completeSale(request([{method:'cash',amountMinor:2000}],'cancel-safe'),shiftId)).rejects.toThrow(/новую оплату/)

    payment.throwOnCharge=true
    await expect(engine.completeSale(request([{method:'card',amountMinor:2000}],'cancel-unknown'),shiftId)).rejects.toThrow(/НЕ повторяйте оплату/)
    const unknown=engine.listUnresolved()[0]
    expect(unknown.canCancel).toBe(true)
    expect(engine.cancelBeforeSideEffects(unknown.id)).toMatchObject({status:'completed'})
    expect(engine.listUnresolved()).toHaveLength(0)

    payment.throwOnCharge=false
    payment.nextCharge={
      status:'unknown',
      bankingEvidence:{
        provider:'inpas',adapter:'direct',terminalId:'terminal-1',referenceNumber:'ref-1',
        amountMinor:2000,operationKind:'sale',startedAt:'2026-09-24T20:00:00.000Z'
      }
    }
    await expect(engine.completeSale(request([{method:'card',amountMinor:2000}],'cancel-evidenced'),shiftId)).rejects.toThrow(/НЕ повторяйте оплату/)
    const evidenced=engine.listUnresolved()[0]
    expect(evidenced.canCancel).toBe(false)
    expect(()=>engine.cancelBeforeSideEffects(evidenced.id)).toThrow(/Отмена недоступна/)
    journal.setState(evidenced.id,'payment_confirmed')
    journal.setConfirmedPayments(evidenced.id,[{method:'card',amountMinor:2000,transactionId:'bank-confirmed'}])
    expect(engine.listUnresolved()[0].canCancel).toBe(false)
    expect(()=>engine.cancelBeforeSideEffects(evidenced.id)).toThrow(/Отмена недоступна/)
  })

  it('does not start payment after an administrator cancels while KKT health is pending',async()=>{
    let finishHealth!:(value:DeviceHealth)=>void
    fiscal.healthCheck=()=>new Promise((resolve)=>{finishHealth=resolve})
    const completing=engine.completeSale(request([{method:'card',amountMinor:2000}],'cancel-during-health'),shiftId)
    const [operation]=engine.listUnresolved()
    expect(operation.canCancel).toBe(true)
    engine.cancelBeforeSideEffects(operation.id)
    finishHealth({ready:true,status:'ready',message:'ready'})
    await expect(completing).rejects.toThrow(/отменена/)
    expect(payment.healthCalls).toBe(0)
    expect(payment.chargeCalls).toBe(0)
    expect(fiscal.saleCalls).toBe(0)
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
    expect(unresolved[0].paymentMethods).toEqual(['cash','card'])
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
    expect(engine.listUnresolved()[0].canCancel).toBe(false)
    expect(()=>engine.cancelBeforeSideEffects(engine.listUnresolved()[0].id)).toThrow(/Отмена недоступна/)
    expect(journal.getLatestFiscalAttempt(engine.listUnresolved()[0].id)?.requestHash).toBeTruthy()

    fiscal.throwOnSale=false
    fiscal.nextStatus={status:'unknown',message:'ФН не даёт однозначного доказательства'}
    const recovery=await engine.recover(engine.listUnresolved()[0].id)
    expect(recovery.status).toBe('attention')
    expect(fiscal.statusCalls).toBe(1)
    expect(fiscal.saleCalls).toBe(1)
    expect(engine.listUnresolved()[0].state).toBe('fiscal_status_unknown')
    const fiscalHash=journal.getLatestFiscalAttempt(engine.listUnresolved()[0].id)?.requestHash
    journal.close()
    journal=new TransactionJournal(join(dir,'journal.sqlite'))
    engine=new PosTransactionEngine(database,journal,payment,fiscal)
    expect(journal.getLatestFiscalAttempt(engine.listUnresolved()[0].id)?.requestHash).toBe(fiscalHash)
    const afterRestart=await engine.recover(engine.listUnresolved()[0].id)
    expect(afterRestart.status).toBe('attention')
    expect(fiscal.saleCalls).toBe(1)
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

  it('refunds the remaining persisted amount after a partial rounded sale return',async()=>{
    const lines=[{productId:'print-bw-a4',name:'Печать',quantity:3,unitPriceMinor:133}]
    const rules={allowDiscounts:false,maxDiscountPercent:0,reviewDiscountPerReviewMinor:0}
    const original=await engine.completeSale({
      clientRequestId:'split-return-source',lines,
      payments:[{method:'cash',amountMinor:300}],discountRules:rules,
      discountBreakdown:calculateDiscountBreakdown(lines,rules),payableMinor:300,
    },shiftId)
    const sale=database.getSale(original.saleId)
    const item=sale.lines[0]
    expect(item.unitPriceMinor*item.quantity).toBe(399)
    await engine.createReturn({
      clientRequestId:'split-return-first',saleId:sale.id,
      lines:[{saleItemId:item.id,quantity:1}],payments:[{method:'cash',amountMinor:100}],
    },shiftId,100,sale)
    const remainder=database.getSale(original.saleId)
    const full=await engine.createReturn({
      clientRequestId:'split-return-final',saleId:sale.id,
      lines:[{saleItemId:item.id,quantity:2}],payments:[{method:'cash',amountMinor:200}],
    },shiftId,200,remainder)
    expect(full.totalMinor).toBe(200)
    expect(fiscal.returns.map((row)=>row.amountMinor)).toEqual([100,200])
    expect(fiscal.returns.map((row)=>(row.lines[0] as {lineTotalMinor?:number}).lineTotalMinor)).toEqual([100,200])
    expect(database.getSale(sale.id).returnedMinor).toBe(300)
  })

  it('returns a legacy pre-rounding sale from its stored kopeck total',async()=>{
    database.saveSale({
      id:'legacy-sale',clientRequestId:'legacy-sale-request',shiftId,totalMinor:199,
      paymentMethod:'cash',fiscalNumber:'FD-legacy',createdAt:new Date().toISOString(),
      receiptDiscountPercent:0,
      lines:[{productId:'print-bw-a4',name:'Печать',quantity:1,unitPriceMinor:199}],
      payments:[{method:'cash',amountMinor:199}],
    })
    const sale=database.getSale('legacy-sale')
    const result=await engine.createReturn({
      clientRequestId:'legacy-return',saleId:sale.id,
      lines:[{saleItemId:sale.lines[0].id,quantity:1}],
      payments:[{method:'cash',amountMinor:199}],
    },shiftId,199,sale)
    expect(result.totalMinor).toBe(199)
    expect(fiscal.returns[0].amountMinor).toBe(199)
    expect((fiscal.returns[0].lines[0] as {lineTotalMinor?:number}).lineTotalMinor).toBe(199)
    expect(database.getSale(sale.id).returnedMinor).toBe(199)
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
    expect((fiscal.returns[0].lines[0] as {lineTotalMinor?:number}).lineTotalMinor).toBe(1000)
    await expect(engine.createReturn({
      clientRequestId:'over-return',saleId:sale.saleId,
      lines:[{saleItemId:first.id,quantity:0.6}],
      payments:[{method:'cash',amountMinor:1200}],
    },shiftId,1200,database.getSale(sale.saleId))).rejects.toThrow(/доступно|превышает/)
  })

  it('journals a return with disconnected KKT before refund and resumes that same return',async()=>{
    const original=await engine.completeSale(request([{method:'cash',amountMinor:2000}],'return-before-kkt'),shiftId)
    const sale=database.getSale(original.saleId)
    const input={clientRequestId:'recover-return-kkt',saleId:sale.id,
      lines:[{saleItemId:sale.lines[0].id,quantity:1}],payments:[{method:'cash' as const,amountMinor:2000}]}
    fiscal.ready=false
    await expect(engine.createReturn(input,shiftId,2000,sale)).rejects.toThrow(/ККТ/)
    const [unresolved]=engine.listUnresolved()
    expect(unresolved).toMatchObject({kind:'return',state:'created',canCancel:true})
    expect(payment.refundCalls).toBe(0)
    expect(fiscal.returnCalls).toBe(0)
    expect(database.findReturnByClientRequestId(input.clientRequestId)).toBeNull()
    expect(database.getSale(sale.id).returnedMinor).toBe(0)
    journal.close()
    journal=new TransactionJournal(join(dir,'journal.sqlite'))
    engine=new PosTransactionEngine(database,journal,payment,fiscal)
    expect(engine.listUnresolved()).toMatchObject([{id:unresolved.id,canCancel:true}])
    fiscal.ready=true
    expect(await engine.recover(unresolved.id)).toMatchObject({status:'completed'})
    expect(fiscal.returnCalls).toBe(1)
    expect(database.getSale(sale.id).returnedMinor).toBe(2000)
    expect(engine.listUnresolved()).toHaveLength(0)
  })


})
