import type {
  FiscalOperationStatus, FiscalProvider, FiscalRequest, FiscalResult, FiscalReturnRequest,
  PaymentProvider, PaymentRequest, PaymentResult
} from './contracts'

export class MockPaymentProvider implements PaymentProvider {
  private readonly results = new Map<string, PaymentResult>()

  async healthCheck() {
    return {ready:true,status:'ready' as const,message:'Тестовый терминал готов'}
  }

  async charge(request: PaymentRequest): Promise<PaymentResult> {
    const result:PaymentResult={status:'approved',transactionId:`MOCK-PAY-${request.method}-${request.saleId.slice(0,8)}`}
    this.results.set(request.operationId,result)
    return result
  }

  async refund(request: PaymentRequest): Promise<PaymentResult> {
    const result:PaymentResult={status:'approved',transactionId:`MOCK-REFUND-${request.method}-${request.saleId.slice(0,8)}`}
    this.results.set(request.operationId,result)
    return result
  }

  async getOperationStatus(request: PaymentRequest): Promise<PaymentResult> {
    return this.results.get(request.operationId)??{status:'declined',message:'Тестовая банковская операция не найдена'}
  }
}

export class MockFiscalProvider implements FiscalProvider {
  private readonly receipts = new Map<string, FiscalResult>()
  private shiftOpen=false

  async healthCheck() {
    return {ready:true,status:'ready' as const,message:'Тестовая ККТ готова'}
  }

  async getShiftStatus(){return this.shiftOpen
    ?{open:true,state:'opened' as const,message:'Тестовая смена открыта'}
    :{open:false,state:'closed' as const,message:'Тестовая смена закрыта'}
  }
  async openShift(){this.shiftOpen=true}
  async closeShift(){this.shiftOpen=false;return {message:'Тестовая фискальная смена закрыта'}}

  async fiscalizeSale(request: FiscalRequest): Promise<FiscalResult> {
    const result={receiptNumber:`TEST-${request.saleId.slice(0,8).toUpperCase()}`}
    this.receipts.set(request.operationId,result)
    return result
  }

  async fiscalizeReturn(request: FiscalReturnRequest): Promise<FiscalResult> {
    const result={receiptNumber:`TEST-RETURN-${request.returnId.slice(0,8).toUpperCase()}`}
    this.receipts.set(request.operationId,result)
    return result
  }

  async getOperationStatus(request:{operationId:string}):Promise<FiscalOperationStatus>{
    const result=this.receipts.get(request.operationId)
    return result?{status:'fiscalized',receiptNumber:result.receiptNumber}:{status:'not_found',message:'Тестовый фискальный документ не найден'}
  }

  async reprintReceipt(request:{saleId:string;receiptNumber:string}) {
    return {kind:'fiscal-copy' as const,status:'simulated' as const,message:`Копия фискального чека ${request.receiptNumber} подготовлена тестовой ККТ`}
  }
}
