export type PaymentMethod = 'cash' | 'card' | 'qr'

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
export type Shift = { id: string; openedAt: string; closedAt?: string; cashierName: string }
export type PointRules = { allowDiscounts: boolean; maxDiscountPercent: number; acceptsCash: boolean; acceptsCard: boolean; acceptsQr: boolean }

export type BootState = {
  pointId: string
  pointName: string
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
  paymentMethod: PaymentMethod
  lines: CartLine[]
  customer?: Customer | null
  receiptDiscountPercent?: number
  cashReceivedMinor?: number
}

export type CompleteSaleResult = { saleId: string; receiptNumber: string; totalMinor: number; changeMinor: number; queuedForSync: boolean }
export type SaleSummary = { id: string; receiptNumber: string; totalMinor: number; paymentMethod: PaymentMethod; customerName?: string; createdAt: string; status: 'completed' | 'returned' }
export type HeldReceipt = { id: string; label: string; lines: CartLine[]; customer?: Customer | null; discountPercent: number; createdAt: string }
export type ShiftSummary = { receipts: number; revenueMinor: number; cashMinor: number; cardMinor: number; qrMinor: number }

export type PosApi = {
  getBootState: () => Promise<BootState>
  listProducts: () => Promise<Product[]>
  listCustomers: (query?: string) => Promise<Customer[]>
  listSales: () => Promise<SaleSummary[]>
  listHeldReceipts: () => Promise<HeldReceipt[]>
  holdReceipt: (receipt: Omit<HeldReceipt, 'id' | 'createdAt'>) => Promise<HeldReceipt>
  deleteHeldReceipt: (id: string) => Promise<void>
  openShift: () => Promise<Shift>
  closeShift: () => Promise<ShiftSummary>
  getShiftSummary: () => Promise<ShiftSummary>
  completeSale: (request: CompleteSaleRequest) => Promise<CompleteSaleResult>
  getConnectionStatus: () => Promise<ConnectionStatus>
  saveConnection: (config: ConnectionConfig) => Promise<ConnectionStatus>
  syncNow: () => Promise<BootState>
}
