export type PaymentMethod = 'cash' | 'card' | 'qr'
export type SalePaymentMethod = PaymentMethod | 'mixed'

export type Product = {
  id: string
  name: string
  sku: string
  category: string
  type: 'product' | 'service' | 'bundle'
  uom: string
  priceMinor: number
  barcode?: string
  stock?: number | null
}

export type Customer = { id: string; name: string; phone?: string; discountPercent: number }
export type CartLine = { productId: string; name: string; quantity: number; unitPriceMinor: number; discountPercent?: number }
export type PaymentPart = { method: PaymentMethod; amountMinor: number; transactionId?: string }
export type Shift = { id: string; openedAt: string; closedAt?: string; cashierName: string }
export type PointRules = { allowDiscounts: boolean; maxDiscountPercent: number; acceptsCash: boolean; acceptsCard: boolean; acceptsQr: boolean }

export type BootState = {
  pointId: string
  pointName: string
  workplaceId: string
  workstationName: string
  cashierName: string
  online: boolean
  pendingSync: number
  lastSyncAt?: string
  source: 'demo' | 'frappe'
  shift: Shift | null
  rules: PointRules
}

export type ConnectionConfig = { serverUrl: string; apiKey: string; apiSecret: string; workplaceCode: string }
export type ConnectionStatus = { configured: boolean; serverUrl: string; workplaceCode: string; lastSyncAt?: string; lastError?: string }

export type CompleteSaleRequest = {
  clientRequestId: string
  payments: PaymentPart[]
  lines: CartLine[]
  customer?: Customer | null
  receiptDiscountPercent?: number
  cashReceivedMinor?: number
}

export type CompleteSaleResult = { saleId: string; receiptNumber: string; totalMinor: number; changeMinor: number; queuedForSync: boolean }
export type SaleSummary = { id: string; receiptNumber: string; totalMinor: number; returnedMinor: number; paymentMethod: SalePaymentMethod; customerName?: string; createdAt: string; status: 'completed' | 'partially_returned' | 'returned' }
export type SaleDetails = SaleSummary & { lines: SaleLine[]; payments: PaymentPart[] }
export type SaleLine = CartLine & { id: number; returnedQuantity: number }

export type ReturnLine = { saleItemId: number; quantity: number }
export type CreateReturnRequest = { clientRequestId: string; saleId: string; lines: ReturnLine[]; payments: PaymentPart[] }
export type ReturnResult = { returnId: string; receiptNumber: string; totalMinor: number; queuedForSync: boolean }
export type ReturnSummary = { id: string; saleId: string; receiptNumber: string; originalReceiptNumber: string; totalMinor: number; createdAt: string }

export type HeldReceipt = { id: string; label: string; lines: CartLine[]; customer?: Customer | null; discountPercent: number; createdAt: string }
export type CashOperationType = 'deposit' | 'withdrawal'
export type CashOperation = { id: string; type: CashOperationType; amountMinor: number; reason: string; createdAt: string }
export type ShiftSummary = {
  receipts: number
  revenueMinor: number
  returnsMinor: number
  cashMinor: number
  cardMinor: number
  qrMinor: number
  depositsMinor: number
  withdrawalsMinor: number
  expectedCashMinor: number
}

export type OutboxEvent = { id: string; eventType: string; payload: unknown; createdAt: string }

export type PosApi = {
  getBootState: () => Promise<BootState>
  listProducts: () => Promise<Product[]>
  listCustomers: (query?: string) => Promise<Customer[]>
  listSales: () => Promise<SaleSummary[]>
  getSale: (id: string) => Promise<SaleDetails>
  createReturn: (request: CreateReturnRequest) => Promise<ReturnResult>
  listReturns: () => Promise<ReturnSummary[]>
  listHeldReceipts: () => Promise<HeldReceipt[]>
  holdReceipt: (receipt: Omit<HeldReceipt, 'id' | 'createdAt'>) => Promise<HeldReceipt>
  deleteHeldReceipt: (id: string) => Promise<void>
  openShift: () => Promise<Shift>
  closeShift: () => Promise<ShiftSummary>
  getShiftSummary: () => Promise<ShiftSummary>
  listCashOperations: () => Promise<CashOperation[]>
  addCashOperation: (type: CashOperationType, amountMinor: number, reason: string) => Promise<CashOperation>
  completeSale: (request: CompleteSaleRequest) => Promise<CompleteSaleResult>
  getConnectionStatus: () => Promise<ConnectionStatus>
  saveConnection: (config: ConnectionConfig) => Promise<ConnectionStatus>
  syncNow: () => Promise<BootState>
}
