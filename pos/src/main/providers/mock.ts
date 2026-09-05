import type { FiscalProvider, FiscalRequest, FiscalResult, PaymentProvider, PaymentRequest, PaymentResult } from './contracts'

export class MockPaymentProvider implements PaymentProvider {
  async charge(request: PaymentRequest): Promise<PaymentResult> {
    return {
      approved: true,
      transactionId: `MOCK-PAY-${request.method}-${request.saleId.slice(0, 8)}`
    }
  }
}

export class MockFiscalProvider implements FiscalProvider {
  async fiscalizeSale(request: FiscalRequest): Promise<FiscalResult> {
    return {
      receiptNumber: `TEST-${request.saleId.slice(0, 8).toUpperCase()}`
    }
  }
}
