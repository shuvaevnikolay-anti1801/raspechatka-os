import { randomUUID } from 'node:crypto'
import { calculateTotalMinor } from '../shared/cart'
import type {
  CompleteSaleRequest, CompleteSaleResult, CreateReturnRequest, PaymentPart, ReturnResult, SaleDetails
} from '../shared/contracts'
import type {
  FiscalProvider, FiscalResult, PaymentProvider, PaymentResult
} from './providers/contracts'
import { PosDatabase } from './database'
import { JournalOperation, TransactionJournal } from './transaction-journal'

const isLocalPayment = (method: PaymentPart['method']) => method === 'cash' || method === 'remote_payment'

export class PosTransactionEngine {
  constructor(
    private readonly database: PosDatabase,
    private readonly journal: TransactionJournal,
    private readonly paymentProvider: PaymentProvider,
    private readonly fiscalProvider: FiscalProvider
  ) {}

  listUnresolved() {
    return this.journal.listUnresolvedSummaries()
  }

  hasBlockingOperation(): boolean {
    return this.journal.listUnresolved().some((operation) =>
      ['payment_in_progress','payment_confirmed','payment_unknown','fiscalization_in_progress','fiscalized','fiscal_status_unknown'].includes(operation.state)
    )
  }

  async completeSale(request: CompleteSaleRequest, shiftId: string, totalMinor?: number): Promise<CompleteSaleResult> {
    const existingSale = this.database.findSaleByClientRequestId(request.clientRequestId)
    if (existingSale) return {...existingSale, changeMinor:0, queuedForSync:true}

    const existingOperation = this.journal.getByClientRequestId(request.clientRequestId)
    if (!existingOperation && this.hasBlockingOperation()) {
      throw new Error('Есть незавершённая операция с деньгами или ККТ. Откройте «Восстановление» и завершите её перед новой оплатой.')
    }

    const saleId = existingOperation?.entityId ?? randomUUID()
    const amount = totalMinor ?? calculateTotalMinor(request.lines, request.receiptDiscountPercent ?? 0)
    const operation = existingOperation ?? this.journal.create({
      id:randomUUID(),clientRequestId:request.clientRequestId,kind:'sale',entityId:saleId,shiftId,
      amountMinor:amount,request
    })
    return this.runSale(operation)
  }

  async createReturn(request: CreateReturnRequest, shiftId: string, totalMinor: number, sale: SaleDetails): Promise<ReturnResult> {
    const existingReturn = this.database.findReturnByClientRequestId(request.clientRequestId)
    if (existingReturn) return {...existingReturn, queuedForSync:true}

    const existingOperation = this.journal.getByClientRequestId(request.clientRequestId)
    if (!existingOperation && this.hasBlockingOperation()) {
      throw new Error('Есть незавершённая операция с деньгами или ККТ. Сначала завершите её в разделе «Восстановление».')
    }
    const returnId = existingOperation?.entityId ?? randomUUID()
    const operation = existingOperation ?? this.journal.create({
      id:randomUUID(),clientRequestId:request.clientRequestId,kind:'return',entityId:returnId,
      relatedSaleId:sale.id,shiftId,amountMinor:totalMinor,request
    })
    return this.runReturn(operation, sale)
  }

  async recover(operationId: string): Promise<{status:'completed'|'attention';message:string}> {
    const operation = this.journal.get(operationId)
    if (!operation) throw new Error('Незавершённая операция не найдена')
    if (operation.state === 'completed') return {status:'completed',message:'Операция уже завершена'}

    await this.reconcileUnknownState(operation)
    const refreshed = this.journal.get(operationId)!
    if (refreshed.kind === 'sale') {
      try {
        await this.runSale(refreshed)
        return {status:'completed',message:'Продажа успешно восстановлена'}
      } catch (error) {
        return {status:'attention',message:error instanceof Error?error.message:String(error)}
      }
    }

    const sale = this.database.getSale(refreshed.relatedSaleId!)
    try {
      await this.runReturn(refreshed, sale)
      return {status:'completed',message:'Возврат успешно восстановлен'}
    } catch (error) {
      return {status:'attention',message:error instanceof Error?error.message:String(error)}
    }
  }

  private async runSale(operation: JournalOperation): Promise<CompleteSaleResult> {
    const request = operation.request as CompleteSaleRequest
    let current = operation
    if (current.state === 'created' || current.state === 'requires_attention') {
      const payments = await this.processPayments(current, request.payments, 'charge')
      this.journal.setConfirmedPayments(current.id,payments)
      this.journal.setState(current.id,'payment_confirmed')
      current = this.journal.get(current.id)!
    }
    if (current.state === 'payment_confirmed') {
      const fiscal = await this.fiscalizeSale(current, request)
      this.journal.setFiscalReceipt(current.id,fiscal.receiptNumber)
      this.journal.setState(current.id,'fiscalized')
      current = this.journal.get(current.id)!
    }
    if (current.state === 'fiscalized') {
      this.database.saveSale({
        id:current.entityId,clientRequestId:current.clientRequestId,shiftId:current.shiftId,totalMinor:current.amountMinor,
        paymentMethod:current.confirmedPayments.length>1?'mixed':current.confirmedPayments[0].method,
        fiscalNumber:current.fiscalReceiptNumber!,createdAt:current.createdAt,
        customerId:request.customer?.id,customerName:request.customer?.name,
        receiptDiscountPercent:request.receiptDiscountPercent??0,lines:request.lines,payments:current.confirmedPayments,order:request.order
      })
      this.journal.setState(current.id,'completed')
    }
    if (!['completed'].includes(this.journal.get(current.id)!.state)) {
      throw new Error('Операция не завершена и требует проверки')
    }
    const sale = this.database.findSaleByClientRequestId(current.clientRequestId)
    if (!sale) throw new Error('Продажа фискализирована, но локальная запись ещё не создана')
    const cashAmount=request.payments.find((x)=>x.method==='cash')?.amountMinor??0
    return {...sale,changeMinor:cashAmount?Math.max(0,(request.cashReceivedMinor??cashAmount)-cashAmount):0,queuedForSync:true,
      order:request.order?this.database.findOrderBySourceSale(current.entityId):undefined}
  }

  private async runReturn(operation: JournalOperation, sale: SaleDetails): Promise<ReturnResult> {
    const request = operation.request as CreateReturnRequest
    const lines=request.lines.map((requested)=>{
      const original=sale.lines.find((x)=>x.id===requested.saleItemId)
      if(!original)throw new Error('Позиция исходного чека не найдена')
      const available=original.quantity-original.returnedQuantity
      if(requested.quantity<=0||requested.quantity>available)throw new Error(`Для «${original.name}» доступно к возврату: ${available}`)
      const originalLineTotal=Math.round(original.quantity*original.unitPriceMinor*(1-(original.discountPercent??0)/100))
      const paidLineTotal=Math.round(sale.totalMinor*originalLineTotal/
        (sale.lines.reduce((sum,x)=>sum+Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent??0)/100)),0)||1))
      return {...requested,lineTotalMinor:Math.round(paidLineTotal*requested.quantity/original.quantity)}
    })

    let current = operation
    if (current.state === 'created' || current.state === 'requires_attention') {
      const payments = await this.processPayments(current, request.payments, 'refund')
      this.journal.setConfirmedPayments(current.id,payments)
      this.journal.setState(current.id,'payment_confirmed')
      current = this.journal.get(current.id)!
    }
    if (current.state === 'payment_confirmed') {
      const fiscal = await this.fiscalizeReturn(current, sale)
      this.journal.setFiscalReceipt(current.id,fiscal.receiptNumber)
      this.journal.setState(current.id,'fiscalized')
      current = this.journal.get(current.id)!
    }
    if (current.state === 'fiscalized') {
      this.database.saveReturn({id:current.entityId,clientRequestId:current.clientRequestId,saleId:sale.id,shiftId:current.shiftId,
        totalMinor:current.amountMinor,fiscalNumber:current.fiscalReceiptNumber!,createdAt:current.createdAt,lines,payments:current.confirmedPayments})
      this.journal.setState(current.id,'completed')
    }
    const saved=this.database.findReturnByClientRequestId(current.clientRequestId)
    if(!saved)throw new Error('Возврат не завершён и требует проверки')
    return {...saved,queuedForSync:true}
  }

  private async processPayments(operation: JournalOperation, requested: PaymentPart[], action:'charge'|'refund'): Promise<PaymentPart[]> {
    if (operation.confirmedPayments.length) return operation.confirmedPayments
    const confirmed:PaymentPart[]=[]
    for (let index=0; index<requested.length; index++) {
      const part=requested[index]
      const attemptId=`${operation.id}:payment:${index}`
      if (isLocalPayment(part.method)) {
        const transactionId=part.method==='cash'?`CASH-${operation.entityId}`:`REMOTE-MANUAL-${operation.entityId}`
        this.journal.startPaymentAttempt({id:attemptId,operationId:operation.id,action,method:part.method,amountMinor:part.amountMinor})
        this.journal.finishPaymentAttempt({id:attemptId,state:'approved',transactionId})
        confirmed.push({...part,transactionId})
        continue
      }

      this.journal.startPaymentAttempt({id:attemptId,operationId:operation.id,action,method:part.method,amountMinor:part.amountMinor})
      this.journal.setState(operation.id,'payment_in_progress')
      let result:PaymentResult
      try {
        result=action==='charge'
          ? await this.paymentProvider.charge({operationId:attemptId,saleId:operation.entityId,amountMinor:part.amountMinor,method:part.method})
          : await this.paymentProvider.refund({operationId:attemptId,saleId:operation.entityId,amountMinor:part.amountMinor,method:part.method})
      } catch(error) {
        const message=error instanceof Error?error.message:String(error)
        this.journal.finishPaymentAttempt({id:attemptId,state:'unknown',error:message})
        this.journal.setState(operation.id,'payment_unknown',message)
        throw new Error('Связь с терминалом потеряна. Результат оплаты неизвестен — НЕ повторяйте оплату. Откройте «Восстановление».')
      }
      if(result.status==='unknown'){
        this.journal.finishPaymentAttempt({id:attemptId,state:'unknown',transactionId:result.transactionId,rawResult:result})
        this.journal.setState(operation.id,'payment_unknown',result.message)
        throw new Error('Терминал не подтвердил итог операции. НЕ повторяйте оплату — проверьте её в «Восстановлении».')
      }
      if(result.status==='declined'){
        this.journal.finishPaymentAttempt({id:attemptId,state:'declined',transactionId:result.transactionId,rawResult:result,error:result.message})
        this.journal.setState(operation.id,'requires_attention',result.message||'Оплата отклонена')
        throw new Error(result.message||'Оплата отклонена')
      }
      this.journal.finishPaymentAttempt({id:attemptId,state:'approved',transactionId:result.transactionId,rawResult:result})
      confirmed.push({...part,transactionId:result.transactionId})
      this.journal.setConfirmedPayments(operation.id,confirmed)
    }
    return confirmed
  }

  private async fiscalizeSale(operation: JournalOperation, request: CompleteSaleRequest): Promise<FiscalResult> {
    const attemptId=`${operation.id}:fiscal`
    this.journal.startFiscalAttempt({id:attemptId,operationId:operation.id,action:'sale'})
    this.journal.setState(operation.id,'fiscalization_in_progress')
    try {
      const result=await this.fiscalProvider.fiscalizeSale({operationId:attemptId,saleId:operation.entityId,
        amountMinor:operation.amountMinor,payments:operation.confirmedPayments,lines:request.lines})
      this.journal.finishFiscalAttempt({id:attemptId,state:'fiscalized',receiptNumber:result.receiptNumber,rawResult:result})
      return result
    } catch(error) {
      const message=error instanceof Error?error.message:String(error)
      this.journal.finishFiscalAttempt({id:attemptId,state:'unknown',error:message})
      this.journal.setState(operation.id,'fiscal_status_unknown',message)
      throw new Error('Не удалось подтвердить результат ККТ. НЕ пробивайте чек повторно. Откройте «Восстановление».')
    }
  }

  private async fiscalizeReturn(operation: JournalOperation, sale: SaleDetails): Promise<FiscalResult> {
    const attemptId=`${operation.id}:fiscal`
    this.journal.startFiscalAttempt({id:attemptId,operationId:operation.id,action:'return'})
    this.journal.setState(operation.id,'fiscalization_in_progress')
    try {
      const result=await this.fiscalProvider.fiscalizeReturn({operationId:attemptId,returnId:operation.entityId,saleId:sale.id,
        amountMinor:operation.amountMinor,payments:operation.confirmedPayments})
      this.journal.finishFiscalAttempt({id:attemptId,state:'fiscalized',receiptNumber:result.receiptNumber,rawResult:result})
      return result
    } catch(error) {
      const message=error instanceof Error?error.message:String(error)
      this.journal.finishFiscalAttempt({id:attemptId,state:'unknown',error:message})
      this.journal.setState(operation.id,'fiscal_status_unknown',message)
      throw new Error('Не удалось подтвердить результат возврата на ККТ. Не повторяйте операцию вслепую — откройте «Восстановление».')
    }
  }

  private async reconcileUnknownState(operation: JournalOperation): Promise<void> {
    if (operation.state === 'payment_unknown' || operation.state === 'payment_in_progress') {
      const attempt=this.journal.getLatestPaymentAttempt(operation.id)
      if(!attempt)throw new Error('Не найдена попытка оплаты для восстановления')
      const result=await this.paymentProvider.getOperationStatus({operationId:attempt.id,saleId:operation.entityId,
        amountMinor:attempt.amountMinor,method:attempt.method as PaymentPart['method']})
      if(result.status==='approved'){
        const payments=[...operation.confirmedPayments]
        if(!payments.some((x)=>x.transactionId===result.transactionId))payments.push({method:attempt.method as PaymentPart['method'],amountMinor:attempt.amountMinor,transactionId:result.transactionId})
        this.journal.finishPaymentAttempt({id:attempt.id,state:'approved',transactionId:result.transactionId,rawResult:result})
        this.journal.setConfirmedPayments(operation.id,payments)
        const expected=(operation.request as CompleteSaleRequest|CreateReturnRequest).payments.length
        this.journal.setState(operation.id,payments.length>=expected?'payment_confirmed':'created')
      }else if(result.status==='declined'){
        this.journal.finishPaymentAttempt({id:attempt.id,state:'declined',transactionId:result.transactionId,rawResult:result,error:result.message})
        this.journal.setState(operation.id,'requires_attention',result.message||'Операция терминала не была оплачена')
      }else{
        this.journal.setState(operation.id,'payment_unknown',result.message||'Терминал всё ещё не даёт однозначный статус')
        throw new Error(result.message||'Результат банковской операции всё ещё неизвестен')
      }
    }

    const refreshed=this.journal.get(operation.id)!
    if(refreshed.state==='fiscal_status_unknown'||refreshed.state==='fiscalization_in_progress'){
      const attempt=this.journal.getLatestFiscalAttempt(operation.id)
      if(!attempt)throw new Error('Не найдена попытка ККТ для восстановления')
      const result=await this.fiscalProvider.getOperationStatus({operationId:attempt.id,entityId:operation.entityId,
        kind:operation.kind,expectedAmountMinor:operation.amountMinor})
      if(result.status==='fiscalized'&&result.receiptNumber){
        this.journal.finishFiscalAttempt({id:attempt.id,state:'fiscalized',receiptNumber:result.receiptNumber,rawResult:result})
        this.journal.setFiscalReceipt(operation.id,result.receiptNumber)
        this.journal.setState(operation.id,'fiscalized')
      }else if(result.status==='not_found'){
        this.journal.finishFiscalAttempt({id:attempt.id,state:'failed',rawResult:result,error:result.message})
        this.journal.setState(operation.id,'payment_confirmed',result.message)
      }else{
        this.journal.setState(operation.id,'fiscal_status_unknown',result.message||'ККТ не дала однозначный статус')
        throw new Error(result.message||'Статус фискального документа всё ещё неизвестен')
      }
    }
  }
}
