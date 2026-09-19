import type { BankingEvidence, BootState, CartLine, PaymentMethod, PaymentPart, PrintResult, SaleDetails } from '../../shared/contracts'

export type DeviceHealth = {
  ready: boolean
  status: 'ready' | 'offline' | 'busy' | 'error' | 'not_configured'
  message: string
  details?: Record<string, unknown>
}

export type PaymentRecoveryEvidence = {
  state?: 'in_progress'|'approved'|'declined'|'unknown'
  kind?: 'sale'|'refund'
  method?: PaymentMethod
  amountMinor?: number
  transactionId?: string
  provider?: string
  adapter?: string
  terminalId?: string
  referenceNumber?: string
  terminalTransactionId?: string
  authorizationCode?: string
  responseCode?: string
  requestHash?: string
  startedAt?: string
  completedAt?: string
  bankingEvidence?: BankingEvidence
  safeResult?: PaymentResult
}

export type PaymentAttemptContext = {
  provider: 'inpas'
  adapter: 'direct'|'console'
  terminalId?: string
}

export type PaymentRequest = {
  operationId: string
  saleId: string
  amountMinor: number
  method: PaymentMethod
  originalPayment?: PaymentPart
  recovery?: PaymentRecoveryEvidence
}

export type PaymentResult = {
  status: 'approved' | 'declined' | 'unknown'
  transactionId?: string
  bankingEvidence?: BankingEvidence
  message?: string
  raw?: unknown
}

export type FiscalRequest = {
  operationId: string
  saleId: string
  amountMinor: number
  payments: PaymentPart[]
  lines: CartLine[]
}

export type FiscalReturnRequest = {
  operationId: string
  returnId: string
  saleId: string
  amountMinor: number
  payments: PaymentPart[]
  lines: CartLine[]
}

export type FiscalResult = {
  receiptNumber: string
  documentNumber?: string
  fiscalDocumentNumber?: string
  fiscalSign?: string
  shiftNumber?: string
  raw?: unknown
}

export type FiscalRecoverySnapshot = {
  kktSerialNumber: string
  shiftNumber?: string
  fiscalDocumentNumber?: string
  fiscalSign?: string
  kktDateTime?: string
  documentClosed?: boolean
  receiptKind?: 'sale'|'return'
  amountMinor?: number
}

export type FiscalRecoveryEvidence = {
  snapshotBefore?: FiscalRecoverySnapshot
  kktSerialNumber?: string
  shiftNumberBefore?: string
  fiscalDocumentNumberBefore?: string
  kktDateTimeBefore?: string
  requestHash?: string
  fiscalDocumentNumberAfter?: string
  fiscalSign?: string
  shiftNumberAfter?: string
  attemptStartedAt?: string
}

export type FiscalOperationStatus = {
  status: 'fiscalized' | 'not_found' | 'unknown'
  receiptNumber?: string
  message?: string
  raw?: unknown
}

export type FiscalShiftStatus = {
  open: boolean
  state: 'opened' | 'closed' | 'expired'
  message: string
}

export interface PaymentProvider {
  getAttemptContext?(): PaymentAttemptContext
  healthCheck(): Promise<DeviceHealth>
  charge(request: PaymentRequest): Promise<PaymentResult>
  refund(request: PaymentRequest): Promise<PaymentResult>
  getOperationStatus(request: PaymentRequest): Promise<PaymentResult>
  testConnection(): Promise<{message:string;receipt?:string;raw?:unknown}>
  reconcile(): Promise<{message:string;receipt?:string;raw?:unknown}>
}

export interface FiscalProvider {
  healthCheck(): Promise<DeviceHealth>
  getShiftStatus(): Promise<FiscalShiftStatus>
  openShift(operatorName?:string): Promise<void>
  closeShift(operatorName?:string): Promise<{message:string;reportNumber?:string}>
  fiscalizeSale(request: FiscalRequest): Promise<FiscalResult>
  fiscalizeReturn(request: FiscalReturnRequest): Promise<FiscalResult>
  captureRecoverySnapshot?():Promise<FiscalRecoverySnapshot|undefined>
  getOperationStatus(request:{operationId:string;entityId:string;kind:'sale'|'return';expectedAmountMinor:number;recovery?:FiscalRecoveryEvidence}):Promise<FiscalOperationStatus>
  reprintReceipt(request: {saleId:string;receiptNumber:string}): Promise<PrintResult>
}

export interface PrintProvider {
  listPrinters():Promise<Array<{name:string;isDefault:boolean}>>
  getSelectedPrinter():string|undefined
  setSelectedPrinter(name:string):Promise<void>
  healthCheck():Promise<DeviceHealth>
  printCommodityReceipt(sale:SaleDetails,boot:BootState):Promise<PrintResult>
}
