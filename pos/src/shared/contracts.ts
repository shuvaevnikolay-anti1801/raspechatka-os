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

export type Customer = {
  id: string
  name: string
  phone: string
  discountPercent: number
}
export type CartLine = {
  productId: string
  name: string
  quantity: number
  unitPriceMinor: number
  discountPercent?: number
  catalogUnitPriceMinor?: number
  priceOverrideReason?: string
  preventDiscounts?: boolean
}
export type ManualDiscountType = 'percent' | 'amount'
export type ManualDiscount = { type: ManualDiscountType; value: number }
export type DiscountRulesSnapshot = {
  allowDiscounts: boolean
  maxDiscountPercent: number
  reviewDiscountPerReviewMinor: number
}
export type DiscountBreakdown = {
  subtotalMinor: number
  discountableSubtotalMinor: number
  clubDiscountPercent: number
  clubDiscountMinor: number
  reviewCount: number
  reviewDiscountMinor: number
  manualDiscountType?: ManualDiscountType
  manualDiscountValue: number
  manualDiscountMinor: number
  totalDiscountMinor: number
  totalMinor: number
}
export type BankingEvidence = {
  provider: 'inpas'
  adapter: 'direct'|'console'
  terminalId: string
  referenceNumber?: string
  terminalTransactionId?: string
  authorizationCode?: string
  responseCode?: string
  transactionStatus?: string
  amountMinor: number
  operationKind: 'sale'|'refund'|'void'|'reconcile'
  originalReferenceNumber?: string
  originalTerminalTransactionId?: string
  startedAt: string
  completedAt?: string
  model?: string
  serial?: string
  receipt?: string
}
export type PaymentPart = {
  method: PaymentMethod
  amountMinor: number
  transactionId?: string
  bankingEvidence?: BankingEvidence
}
export type RemotePaymentConfirmation = { confirmed: true; confirmedAt: string; confirmedBy?: string; note?: string }
export type Shift = {
  id:string
  openedAt:string
  closedAt?:string
  cashierId?:string
  cashierName:string
  shiftType?:'Утро'|'Вечер'
  drawerPointId?:string
  drawerWorkplaceId?:string
  openingExpectedMinor?:number
  openingExpectedVerified?:boolean
  accountingBaselineAt?:string
  openingCountPending?:boolean
}
export type PointEmployee = { id:string; name:string }
export type CashierAuthState = {
  status:'signed_out'|'authenticated'|'locked'
  employee?:PointEmployee
  openShiftCashierId?:string
  openShiftCashierName?:string
  requiresPinSetup?:boolean
}
export type ReceiptMirror = SaleDetails & { pointId:string; serverId:string; externalId?:string; cashierId?:string; cashierName?:string; customerPhone?:string; shiftExternalId?:string }
export type UpsellCandidate = {
  item: string
  cashierPhrase?: string
}
export type UpsellRule = {
  triggerItem: string
  enabled: boolean
  candidates: UpsellCandidate[]
}
export type PointRules = {
  allowFreePrice: boolean
  allowRemoveCartItem: boolean
  allowDiscounts: boolean
  maxDiscountPercent: number
  acceptsCash: boolean
  acceptsCard: boolean
  acceptsQr: boolean
  acceptsRemotePayment?: boolean
  reviewDiscountPerReviewMinor?: number
}

export type BootState = {
  pointId: string
  pointName: string
  /** Business Point timezone; optional for compatibility with older cached boot state. */
  pointTimezone?: string
  workplaceId: string
  workstationName: string
  cashierId?: string
  cashierName: string
  employees: PointEmployee[]
  accessRevoked: boolean
  online: boolean
  pendingSync: number
  masterDataError?: string
  documentQueueError?: string
  documentQueueSynced?: boolean
  lastSyncAt?: string
  source: 'demo' | 'frappe'
  shift: Shift | null
  rules: PointRules
  upsellRules: UpsellRule[]
  upsellCursors: Record<string, number>
}

export type ConnectionConfig = { serverUrl: string; deviceId?: string; token?: string; apiKey?:string; apiSecret?:string; workplaceCode?:string }
export type ConnectionStatus = { configured: boolean; serverUrl: string; deviceId?: string; workplaceCode?:string; lastSyncAt?: string; lastError?: string }
export type PosLifecycleState = 'NEW' | 'CONFIGURING' | 'READY'
export type PosLifecycleStatus = {
  state: PosLifecycleState
  updatedAt: string
  legacyInstallation?: boolean
}

export type CompleteSaleRequest = {
  clientRequestId: string
  payments: PaymentPart[]
  lines: CartLine[]
  customer?: Customer | null
  receiptDiscountPercent?: number
  clubDiscountPercent?: number
  clubDiscountMinor?: number
  reviewCount?: number
  reviewDiscountMinor?: number
  manualDiscount?: ManualDiscount | null
  manualDiscountType?: ManualDiscountType | null
  manualDiscountValue?: number
  manualDiscountMinor?: number
  discountBreakdown?: DiscountBreakdown
  totalDiscountMinor?: number
  discountRules?: DiscountRulesSnapshot
  cashReceivedMinor?: number
  remotePaymentConfirmation?: RemotePaymentConfirmation
  order?: { phone:string; comment?:string; dueAt?:string }
}

export type CompleteSaleResult = { saleId: string; receiptNumber: string; totalMinor: number; changeMinor: number; queuedForSync: boolean; order?: Order }
export type SaleSummary = {
  id:string
  receiptNumber:string
  serverId?:string
  totalMinor:number
  returnedMinor:number
  paymentMethod:SalePaymentMethod
  paymentMethods?:PaymentMethod[]
  customerName?:string
  customerPhone?:string
  cashierId?:string
  cashierName?:string
  shiftId?:string
  searchText?:string
  createdAt:string
  status:'completed'|'partially_returned'|'returned'
  returnable?:boolean
  source?:'local'|'server'
}
export type SaleDetails = SaleSummary & { lines: SaleLine[]; payments: PaymentPart[]; remotePaymentConfirmation?: RemotePaymentConfirmation }
export type SaleLine = CartLine & { id: number; returnedQuantity: number }

export type ReceiptSearchFilters = {
  period?:'current_shift'|'today'|'yesterday'|'7d'|'30d'|'custom'|'all'
  shiftExternalId?:string
  dateFrom?:string
  dateTo?:string
  cashierId?:string
  amountMinMinor?:number
  amountMaxMinor?:number
  paymentChannel?:'Cash'|'Noncash'|''
  receiptType?:'Sale'|'Return'|''
}
export type PointReceiptSummary = {
  id:string
  externalId?:string
  receiptNumber:string
  receiptType:'Sale'|'Return'
  createdAt:string
  customerName:string
  customerPhone?:string
  cashierId?:string
  cashierName?:string
  shiftExternalId?:string
  paymentLabel:string
  totalMinor:number
  discountMinor:number
  reviewDiscountMinor:number
  status:string
}
export type PointReceiptLine = {
  productId?:string
  name:string
  quantity:number
  unitPriceMinor:number
  discountPercent?:number
  lineTotalMinor:number
  returnedQuantity?:number
}
export type PointReceiptPayment = {
  method?:PaymentMethod
  channel:string
  amountMinor:number
  transactionId?:string
}
export type PointReceiptDetails = PointReceiptSummary & {
  lines:PointReceiptLine[]
  payments:PointReceiptPayment[]
  originalReceiptId?:string
}

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

export type HeldReceipt = {
  id: string
  label: string
  lines: CartLine[]
  customer?: Customer | null
  discountPercent: number
  reviewCount?: number
  manualDiscount?: ManualDiscount | null
  totalMinor?: number
  createdAt: string
}
export type CashOperationType = 'deposit' | 'withdrawal'
export type CashOperation = { id: string; type: CashOperationType; amountMinor: number; reason: string; createdAt: string }
export type ShiftSummary = {
  receipts: number
  revenueMinor: number
  grossRevenueMinor?: number
  averageCheckBeforeDiscountMinor?: number
  returnsMinor: number
  cashMinor: number
  cardMinor: number
  qrMinor: number
  remotePaymentMinor?: number
  depositsMinor: number
  withdrawalsMinor: number
  expectedCashMinor: number
  expectedCashVerified?: boolean
  openingCountPending?: boolean
}

export type OutboxEvent = { id: string; eventType: string; payload: unknown; createdAt: string }

export type WorkScheduleItem = { id:string; date:string; shiftName:string; startTime:string; endTime:string; plannedHours:number }
export type WorkScheduleEntry = {
  id:string; date:string; employeeId:string; employeeName?:string; shiftTemplate:string;
  shiftCode:string; shiftName:string; startTime:string; endTime:string; plannedHours:number
}
export type WorkScheduleMonth = {
  month:string; days:number; employees:Array<{id:string;name:string}>; entries:WorkScheduleEntry[]
}
export type UpcomingShift = Omit<WorkScheduleEntry,'employeeId'|'employeeName'>
export type OperationalCatalogItem = {
  id:string; name:string; itemCode:string; itemType:string; uom:string;
  trackInventory:boolean; stock:number|null; storageAddress:string
}
export type DeliveryNoticeItem = {
  purchaseOrderItemId:string; itemId:string; itemName:string; itemCode:string; uom:string;
  orderedQuantity:number; receivedQuantity:number; remainingQuantity:number
}
export type DeliveryNotice = {
  id:string; supplier:string; expectedDate?:string; deliveryCompany?:string; deliveryCode?:string;
  receivingNote?:string; comment?:string; details?:string; status:string; items:DeliveryNoticeItem[]
}
export type PointSupplyRequest = { id:string; createdAt:string; itemName:string; quantity:number; status:string; comment?:string }
export type CleanerVisit = { id:string; visitDate:string; recordedBy:string; paid:boolean }
export type CleanerStatus = { visitsSincePayment:number; paymentDueMinor:number; recentVisits:CleanerVisit[] }
export type WorkplaceData = {
  schedule:WorkScheduleItem[]
  scheduleMonth:WorkScheduleMonth
  myUpcomingShifts:UpcomingShift[]
  operationalCatalog:OperationalCatalogItem[]
  deliveries:DeliveryNotice[]
  supplyRequests:PointSupplyRequest[]
  cleaner:CleanerStatus
  orders:Order[]
}
export type StockWriteOffRequest = { productId:string; quantity:number; reason:'Брак'|'Внутренние нужды'|'Обучение'|'Другое'; comment?:string }
export type SupplyRequestInput = { productId?:string; itemName:string; quantity:number; comment?:string }
export type StockReceiptRequest = {
  purchaseOrderId:string
  lines:Array<{purchaseOrderItemId:string;quantity:number}>
}
export type CashCountLine = { denominationMinor:number; quantity:number }
export type CashCount = { id:string; countType:'opening'|'control'|'closing'; lines:CashCountLine[]; totalMinor:number; expectedMinor:number; expectedVerified?:boolean; differenceMinor:number; createdAt:string }
export type CashDrawerBaselineSource =
  | 'fresh_install'
  | 'legacy_opening_count'
  | 'legacy_control_count'
  | 'legacy_closing_count'
  | 'legacy_unverified'
  | 'cash_count'
export type CashDrawerState = {
  schemaVersion:1
  pointId:string
  workplaceId:string
  baselineMinor:number|null
  baselineVerified:boolean
  openingCountPending:boolean
  baselineSource:CashDrawerBaselineSource
  baselineSourceId?:string
  baselineAt?:string
  migratedAt:string
  updatedAt:string
}
export type CleanerVisitResult = { visit:CleanerVisit; visitsSincePayment:number; paymentDueMinor:number }
export type OrderStatus = 'new'|'in_progress'|'ready'|'issued'|'cancelled'
export type OrderPaymentStatus = 'unpaid'|'partial'|'paid'
export type Order = { id:string; orderNumber:string; phone:string; customerName?:string; lines:CartLine[]; totalMinor:number; paidMinor:number; paymentStatus:OrderPaymentStatus; status:OrderStatus; comment?:string; createdAt:string; dueAt?:string; readyAt?:string; issuedAt?:string; sourceSaleId?:string; sourceReceipt?:string; fiscalNumber?:string }
export type CreateUnpaidOrderRequest = { phone:string; lines:CartLine[]; comment?:string; dueAt?:string }
export type CreateOrderFromSaleRequest = { saleId:string; phone:string; comment:string; dueAt:string }
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

export type AtolDirectDevice = { serialNumber:string; modelName:string; connection:'usb'|'com'|'tcp'; settingsJson:string }
export type AtolSettings = { version:2; enabled:boolean; adapter:'driver'|'web'; taxationType:string; taxType:string; direct?:{selectedDevice?:AtolDirectDevice}; web:{baseUrl:string} }
export type AtolDriverInfo = { installed:boolean; version?:string; architecture?:'x64'|'x86'; error?:string; code?:string }
export type AtolDriverDevice = AtolDirectDevice & { id:string; firmwareVersion?:string }
export type AtolDriverStatus = { connected:boolean; driverVersion?:string; serialNumber?:string; modelName?:string; firmwareVersion?:string; shiftState?:string|number; paperPresent?:boolean; coverOpened?:boolean; printerConnectionLost?:boolean; printerError?:boolean; fnPresent?:boolean; invalidFn?:boolean; deviceBlocked?:boolean; errorCode?:number; errorDescription?:string }

export type PosApi = {
  getBootState: () => Promise<BootState>
  getPosLifecycle: () => Promise<PosLifecycleStatus>
  beginInitialSetup: () => Promise<PosLifecycleStatus>
  completeInitialSetup: () => Promise<PosLifecycleStatus>
  listProducts: () => Promise<Product[]>
  listCustomers: (query?: string) => Promise<Customer[]>
  getCustomer: (id: string) => Promise<Customer|null>
  listSales: () => Promise<SaleSummary[]>
  searchPointReceipts: (query?:string, filters?:ReceiptSearchFilters) => Promise<PointReceiptSummary[]>
  getPointReceipt: (id:string) => Promise<PointReceiptDetails>
  getSale: (id: string) => Promise<SaleDetails>
  createReturn: (request: CreateReturnRequest) => Promise<ReturnResult>
  listReturns: () => Promise<ReturnSummary[]>
  printSale: (id: string, kind: PrintKind) => Promise<PrintResult>
  printPointReceiptCommodity: (id:string) => Promise<PrintResult>
  listPrintJobs: () => Promise<PrintJobSummary[]>
  retryPrintJob: (id:string) => Promise<PrintResult>
  listPrinters: () => Promise<PrinterInfo[]>
  getSelectedPrinter: () => Promise<string|undefined>
  setSelectedPrinter: (name:string) => Promise<void>
  getDeviceStatuses: () => Promise<DeviceStatuses>
  listUnresolvedOperations: () => Promise<UnresolvedOperation[]>
  recoverOperation: (id:string) => Promise<RecoveryResult>
  listDiagnosticEvents: (limit?:number) => Promise<DiagnosticEvent[]>
  getAtolSettings: () => Promise<AtolSettings>
  saveAtolSettings: (value:AtolSettings) => Promise<AtolSettings>
  getAtolDriverInfo: () => Promise<AtolDriverInfo>
  discoverAtolDevices: () => Promise<AtolDriverDevice[]>
  selectAtolDevice: (device:AtolDirectDevice) => Promise<AtolSettings>
  testAtolDriverDevice: () => Promise<AtolDriverStatus>
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
  createStockReceipt: (request:StockReceiptRequest) => Promise<void>
  recordCleanerVisit: () => Promise<CleanerVisitResult>
  payCleaner: (amountMinor:number) => Promise<CashOperation>
  saveCashCount: (countType:CashCount['countType'], lines:CashCountLine[]) => Promise<CashCount>
  getLastCashCount: () => Promise<CashCount|null>
  listOrders: () => Promise<Order[]>
  createUnpaidOrder: (request:CreateUnpaidOrderRequest) => Promise<Order>
  createOrderFromSale: (request:CreateOrderFromSaleRequest) => Promise<Order>
  updateOrder: (request:UpdateOrderRequest) => Promise<Order>
  completeSale: (request: CompleteSaleRequest) => Promise<CompleteSaleResult>
  getConnectionStatus: () => Promise<ConnectionStatus>
  saveConnection: (config: ConnectionConfig) => Promise<ConnectionStatus>
  getCashierAuthState: () => Promise<CashierAuthState>
  beginCashierLogin: (cashierId:string) => Promise<{requiresPinSetup:boolean}>
  createCashierPin: (cashierId:string,pin:string,confirmation:string) => Promise<CashierAuthState>
  loginCashier: (cashierId:string,pin:string) => Promise<CashierAuthState>
  lockCashier: () => Promise<CashierAuthState>
  unlockCashier: (pin:string) => Promise<CashierAuthState>
  logoutCashier: () => Promise<CashierAuthState>
  verifyAdminCode: (code:string) => Promise<boolean>
  resetCashierPin: (cashierId:string,adminCode:string,newPin:string,confirmation:string) => Promise<void>
  setUpsellCursor: (triggerItem:string,cursor:number) => Promise<void>
  syncConfiguration: () => Promise<BootState>
  syncNow: () => Promise<BootState>
}
