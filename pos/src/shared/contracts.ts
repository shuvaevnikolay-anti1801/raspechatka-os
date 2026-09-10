export type PaymentMethod = 'cash' | 'card' | 'qr' | 'remote_payment'
export type SalePaymentMethod = string

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
export type RemotePaymentConfirmation = { confirmed: true; confirmedAt: string; confirmedBy?: string; note?: string }
export type Shift = { id: string; openedAt: string; closedAt?: string; cashierName: string }
export type PointEmployee = { id:string; name:string }
export type PointRules = { allowFreePrice: boolean; allowRemoveCartItem: boolean; allowDiscounts: boolean; maxDiscountPercent: number; acceptsCash: boolean; acceptsCard: boolean; acceptsQr: boolean; acceptsRemotePayment?: boolean }

export type BootState = {
  pointId: string
  pointName: string
  workplaceId: string
  workstationName: string
  cashierId?: string
  cashierName: string
  employees: PointEmployee[]
  online: boolean
  pendingSync: number
  lastSyncAt?: string
  source: 'demo' | 'frappe'
  shift: Shift | null
  rules: PointRules
}

export type ConnectionConfig = { serverUrl: string; deviceId?: string; token?: string; cashierId?: string; apiKey?:string; apiSecret?:string; workplaceCode?:string }
export type ConnectionStatus = { configured: boolean; serverUrl: string; deviceId?: string; cashierId?: string; workplaceCode?:string; lastSyncAt?: string; lastError?: string }

export type CompleteSaleRequest = {
  clientRequestId: string
  payments: PaymentPart[]
  lines: CartLine[]
  customer?: Customer | null
  receiptDiscountPercent?: number
  cashReceivedMinor?: number
  remotePaymentConfirmation?: RemotePaymentConfirmation
  order?: { phone:string; comment?:string; dueAt?:string }
}

export type CompleteSaleResult = { saleId: string; receiptNumber: string; totalMinor: number; changeMinor: number; queuedForSync: boolean; order?: Order; commodityPrintWarning?: string }
export type SaleSummary = { id: string; receiptNumber: string; totalMinor: number; returnedMinor: number; paymentMethod: SalePaymentMethod; customerName?: string; createdAt: string; status: 'completed' | 'partially_returned' | 'returned' }
export type SaleDetails = SaleSummary & { lines: SaleLine[]; payments: PaymentPart[]; remotePaymentConfirmation?: RemotePaymentConfirmation }
export type SaleLine = CartLine & { id: number; returnedQuantity: number }

export type ReturnLine = { saleItemId: number; quantity: number }
export type CreateReturnRequest = { clientRequestId: string; saleId: string; lines: ReturnLine[]; payments: PaymentPart[] }
export type ReturnResult = { returnId: string; receiptNumber: string; totalMinor: number; queuedForSync: boolean }
export type ReturnSummary = { id: string; saleId: string; receiptNumber: string; originalReceiptNumber: string; totalMinor: number; createdAt: string }
export type PrintKind = 'fiscal-copy' | 'commodity'
export type PrintResult = { kind: PrintKind; status: 'printed' | 'simulated'; message: string }
export type PrintJobSummary = {
  id:string
  saleId:string
  kind:'commodity'
  state:'pending'|'printing'|'printed'|'error'
  attempts:number
  lastError?:string
  createdAt:string
  updatedAt:string
  printedAt?:string
}

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
  remotePaymentMinor?: number
  depositsMinor: number
  withdrawalsMinor: number
  expectedCashMinor: number
}

export type OutboxEvent = { id: string; eventType: string; payload: unknown; createdAt: string }

export type WorkScheduleItem = { id:string; date:string; shiftName:string; startTime:string; endTime:string; plannedHours:number }
export type DeliveryNotice = { id:string; supplier:string; expectedDate?:string;deliveryCompany?:string; deliveryCode?:string; details?:string; status:string }
export type PointSupplyRequest = { id:string; createdAt:string; itemName:string; quantity:number; status:string; comment?:string }
export type CleanerVisit = { id:string; visitDate:string; recordedBy:string; paid:boolean }
export type CleanerStatus = { visitsSincePayment:number; paymentDueMinor:number; recentVisits:CleanerVisit[] }
export type WorkplaceData = { schedule:WorkScheduleItem[]; deliveries:DeliveryNotice[]; supplyRequests:PointSupplyRequest[]; cleaner:CleanerStatus; orders:Order[] }
export type StockWriteOffRequest = { productId:string; quantity:number; reason:'Брак'|'Внутренние нужды'|'Обучение'|'Другое'; comment?:string }
export type SupplyRequestInput = { productId?:string; itemName:string; quantity:number; comment?:string }
export type CashCountLine = { denominationMinor:number; quantity:number }
export type CashCount = { id:string; countType:'opening'|'control'|'closing'; lines:CashCountLine[]; totalMinor:number; expectedMinor:number; differenceMinor:number; createdAt:string }
export type CleanerVisitResult = { visit:CleanerVisit; visitsSincePayment:number; paymentDueMinor:number }
export type OrderStatus = 'new'|'in_progress'|'ready'|'issued'|'cancelled'
export type OrderPaymentStatus = 'unpaid'|'partial'|'paid'
export type Order = { id:string; orderNumber:string; phone:string; customerName?:string; lines:CartLine[]; totalMinor:number; paidMinor:number; paymentStatus:OrderPaymentStatus; status:OrderStatus; comment?:string; createdAt:string; dueAt?:string; sourceSaleId?:string; fiscalNumber?:string }
export type CreateUnpaidOrderRequest = { phone:string; lines:CartLine[]; comment?:string; dueAt?:string }
export type UpdateOrderRequest = { id:string; phone?:string; comment?:string; status?:OrderStatus; dueAt?:string }

export type HardwareStatus = {ready:boolean;status:'ready'|'offline'|'busy'|'error'|'not_configured';message:string;details?:Record<string,unknown>}
export type ShiftDeviceStatus = {ready:boolean;localOpen:boolean;fiscalOpen?:boolean;message:string}
export type DeviceStatuses = { os:HardwareStatus; fiscal:HardwareStatus; payment:HardwareStatus; printer:HardwareStatus; shift:ShiftDeviceStatus }
export type InpasSettings = {enabled:boolean;executablePath:string;terminalId:string;currencyCode:string;timeoutMs:number;qrMode:'terminal_choice'}
export type PaymentServiceResult = {message:string;receipt?:string;raw?:unknown}
export type PrinterInfo = {name:string;isDefault:boolean}
export type TransactionState = 'created'|'payment_in_progress'|'payment_confirmed'|'payment_unknown'|'fiscalization_in_progress'|'fiscalized'|'fiscal_status_unknown'|'completed'|'cancelled'|'requires_attention'
export type UnresolvedOperation = {
  id:string
  clientRequestId:string
  kind:'sale'|'return'
  entityId:string
  relatedSaleId?:string
  shiftId:string
  amountMinor:number
  state:TransactionState
  fiscalReceiptNumber?:string
  lastError?:string
  createdAt:string
  updatedAt:string
  paymentMethods:string[]
}
export type RecoveryResult = {status:'completed'|'attention';message:string}
export type DiagnosticEvent = {
  id:string
  level:'info'|'warning'|'error'
  source:'app'|'shift'|'payment'|'fiscal'|'printer'|'sync'|'recovery'
  eventType:string
  message:string
  operationId?:string
  details?:Record<string,unknown>
  createdAt:string
}

export type PosApi = {
  getBootState: () => Promise<BootState>
  listProducts: () => Promise<Product[]>
  listCustomers: (query?: string) => Promise<Customer[]>
  listSales: () => Promise<SaleSummary[]>
  getSale: (id: string) => Promise<SaleDetails>
  createReturn: (request: CreateReturnRequest) => Promise<ReturnResult>
  listReturns: () => Promise<ReturnSummary[]>
  printSale: (id: string, kind: PrintKind) => Promise<PrintResult>
  listPrintJobs: () => Promise<PrintJobSummary[]>
  retryPrintJob: (id:string) => Promise<PrintResult>
  listPrinters: () => Promise<PrinterInfo[]>
  getSelectedPrinter: () => Promise<string|undefined>
  setSelectedPrinter: (name:string) => Promise<void>
  getDeviceStatuses: () => Promise<DeviceStatuses>
  listUnresolvedOperations: () => Promise<UnresolvedOperation[]>
  recoverOperation: (id:string) => Promise<RecoveryResult>
  listDiagnosticEvents: (limit?:number) => Promise<DiagnosticEvent[]>
  getInpasSettings: () => Promise<InpasSettings>
  saveInpasSettings: (value:InpasSettings) => Promise<InpasSettings>
  testPaymentTerminal: () => Promise<PaymentServiceResult>
  reconcilePaymentTerminal: () => Promise<PaymentServiceResult>
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
  listOrders: () => Promise<Order[]>
  createUnpaidOrder: (request:CreateUnpaidOrderRequest) => Promise<Order>
  updateOrder: (request:UpdateOrderRequest) => Promise<Order>
  completeSale: (request: CompleteSaleRequest) => Promise<CompleteSaleResult>
  getConnectionStatus: () => Promise<ConnectionStatus>
  saveConnection: (config: ConnectionConfig) => Promise<ConnectionStatus>
  setActiveCashier: (cashierId:string) => Promise<BootState>
  syncNow: () => Promise<BootState>
}
