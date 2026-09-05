export type PaymentMethod = 'cash' | 'card'

export type Product = {
  id: string
  name: string
  sku: string
  category: string
  priceMinor: number
}

export type CartLine = {
  productId: string
  name: string
  quantity: number
  unitPriceMinor: number
}

export type Shift = {
  id: string
  openedAt: string
  cashierName: string
}

export type BootState = {
  pointName: string
  workstationName: string
  cashierName: string
  online: boolean
  pendingSync: number
  shift: Shift | null
}

export type CompleteSaleRequest = {
  clientRequestId: string
  paymentMethod: PaymentMethod
  lines: CartLine[]
}

export type CompleteSaleResult = {
  saleId: string
  receiptNumber: string
  totalMinor: number
  queuedForSync: boolean
}

export type PosApi = {
  getBootState: () => Promise<BootState>
  listProducts: () => Promise<Product[]>
  openShift: () => Promise<Shift>
  completeSale: (request: CompleteSaleRequest) => Promise<CompleteSaleResult>
}
