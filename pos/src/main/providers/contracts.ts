import type { BootState, CartLine, PaymentMethod, PaymentPart, PrintResult, SaleDetails } from '../../shared/contracts'

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
  payments: PaymentPart[]
  lines: CartLine[]
}

export type FiscalReturnRequest = {
  returnId: string
  saleId: string
  amountMinor: number
  payments: PaymentPart[]
}

export type FiscalResult = {
  receiptNumber: string
}

export interface PaymentProvider {
  charge(request: PaymentRequest): Promise<PaymentResult>
  refund(request: PaymentRequest): Promise<PaymentResult>
}

export interface FiscalProvider {
  fiscalizeSale(request: FiscalRequest): Promise<FiscalResult>
  fiscalizeReturn(request: FiscalReturnRequest): Promise<FiscalResult>
  reprintReceipt(request: {saleId:string;receiptNumber:string}): Promise<PrintResult>
}

export interface PrintProvider {
  printCommodityReceipt(sale:SaleDetails,boot:BootState):Promise<PrintResult>
}
