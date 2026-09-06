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
  trackInventory?: boolean
  allowNegativeStock?: boolean
  minimumSalePriceMinor?: number
  preventDiscounts?: boolean
  storageAddress?: string
}

export type Customer = { id: string; name: string; phone?: string; discountPercent: number; purchaseCount?: number; totalSpentMinor?: number }
export type CartLine = { productId: string; name: string; quantity: number; unitPriceMinor: number; discountPercent?: number }
export type PaymentPart = { method: PaymentMethod; amountMinor: number; transactionId?: string }
export type Shift = { id: string; openedAt: string; closedAt?: string; cashierName: string }
export type PointRules = { allowFreePrice: boolean; allowRemoveCartItem: boolean; allowDiscounts: boolean; maxDiscountPercent: number; acceptsCash: boolean; acceptsCard: boolean; acceptsQr: boolean }

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
export type PrintKind = 'fiscal-copy' | 'commodity'
export type PrintResult = { kind: PrintKind; status: 'printed' | 'simulated'; message: string }

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

export type WorkScheduleItem = { id:string; date:string; shiftName:string; startTime:string; endTime:string; plannedHours:number }
export type DeliveryNotice = { id:string; supplier:string; expectedDate?:string; deliveryCompany?:string; deliveryCode?:string; details?:string; status:string }
export type PointSupplyRequest = { id:string; createdAt:string; itemName:string; quantity:number; status:string; comment?:string }
export type CleanerVisit = { id:string; visitDate:string; recordedBy:string; paid:boolean }
export type CleanerStatus = { visitsSincePayment:number; paymentDueMinor:number; recentVisits:CleanerVisit[] }
export type WorkplaceData = { schedule:WorkScheduleItem[]; deliveries:DeliveryNotice[]; supplyRequests:PointSupplyRequest[]; cleaner:CleanerStatus }
export type StockWriteOffRequest = { productId:string; quantity:number; reason:'Брак'|'Внутренние нужды'|'Обучение'|'Другое'; comment?:string }
export type SupplyRequestInput = { productId?:string; itemName:string; quantity:number; comment?:string }
export type CashCountLine = { denominationMinor:number; quantity:number }
export type CashCount = { id:string; countType:'opening'|'control'|'closing'; lines:CashCountLine[]; totalMinor:number; expectedMinor:number; differenceMinor:number; createdAt:string }
export type CleanerVisitResult = { visit:CleanerVisit; visitsSincePayment:number; paymentDueMinor:number }

export type PosApi = {
  getBootState: () => Promise<BootState>
  listProducts: () => Promise<Product[]>
  listCustomers: (query?: string) => Promise<Customer[]>
  listSales: () => Promise<SaleSummary[]>
  getSale: (id: string) => Promise<SaleDetails>
  createReturn: (request: CreateReturnRequest) => Promise<ReturnResult>
  listReturns: () => Promise<ReturnSummary[]>
  printSale: (id: string, kind: PrintKind) => Promise<PrintResult>
  listHeldReceipts: () => Promise<HeldReceipt[]>
  holdReceipt: (receipt: Omit<HeldReceipt, 'id' | 'createdAt'>) => Promise<HeldReceipt>
  deleteHeldReceipt: (id: string) => Promise<void>
  openShift: () => Promise<Shift>
  closeShift: () => Promise<ShiftSummary>
  getShiftSummary: () => Promise<ShiftSummary>
  listCashOperations: () => Promise<CashOperation[]>
  addCashOperation: (type: CashOperationType, amountMinor: number, reason: string) => Promise<CashOperation>
  getWorkplaceData: () => Promise<WorkplaceData>
  reportStockWriteOff: (request:StockWriteOffRequest) => Promise<void>
  createSupplyRequest: (request:SupplyRequestInput) => Promise<void>
  recordCleanerVisit: () => Promise<CleanerVisitResult>
  payCleaner: (amountMinor:number) => Promise<CashOperation>
  saveCashCount: (countType:CashCount['countType'], lines:CashCountLine[]) => Promise<CashCount>
  getLastCashCount: () => Promise<CashCount|null>
  completeSale: (request: CompleteSaleRequest) => Promise<CompleteSaleResult>
  getConnectionStatus: () => Promise<ConnectionStatus>
  saveConnection: (config: ConnectionConfig) => Promise<ConnectionStatus>
  syncNow: () => Promise<BootState>
}
