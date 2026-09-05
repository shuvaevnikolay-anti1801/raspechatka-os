import type { CartLine, PaymentMethod } from '../../shared/contracts'

export type PaymentRequest = {
  saleId: string
  amountMinor: number
  method: PaymentMethod
}

export type PaymentResult = {
  approved: boolean
  transactionId: string
}

export type FiscalRequest = {
  saleId: string
  amountMinor: number
  paymentMethod: PaymentMethod
  lines: CartLine[]
}

export type FiscalResult = {
  receiptNumber: string
}

export interface PaymentProvider {
  charge(request: PaymentRequest): Promise<PaymentResult>
}

export interface FiscalProvider {
  fiscalizeSale(request: FiscalRequest): Promise<FiscalResult>
}
