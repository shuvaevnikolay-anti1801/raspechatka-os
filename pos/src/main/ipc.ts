import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { calculateTotalMinor } from '../shared/cart'
import type { BootState, CompleteSaleRequest, CompleteSaleResult, Shift } from '../shared/contracts'
import { PosDatabase } from './database'
import type { FiscalProvider, PaymentProvider } from './providers/contracts'

export function registerIpcHandlers(dependencies: {
  database: PosDatabase
  paymentProvider: PaymentProvider
  fiscalProvider: FiscalProvider
}): void {
  const { database, paymentProvider, fiscalProvider } = dependencies
  const cashierName = 'Администратор'

  ipcMain.handle('pos:get-boot-state', (): BootState => ({
    pointName: 'Тестовая точка',
    workstationName: 'Касса 1',
    cashierName,
    online: true,
    pendingSync: database.pendingSyncCount(),
    shift: database.currentShift()
  }))

  ipcMain.handle('pos:list-products', () => database.listProducts())

  ipcMain.handle('pos:open-shift', (): Shift => database.openShift({
    id: randomUUID(),
    openedAt: new Date().toISOString(),
    cashierName
  }))

  ipcMain.handle('pos:complete-sale', async (_event, request: CompleteSaleRequest): Promise<CompleteSaleResult> => {
    const existing = database.findSaleByClientRequestId(request.clientRequestId)
    if (existing) return { ...existing, queuedForSync: true }

    const shift = database.currentShift()
    if (!shift) throw new Error('Сначала откройте смену')
    if (!request.lines.length) throw new Error('Чек пуст')

    const totalMinor = calculateTotalMinor(request.lines)
    const saleId = randomUUID()
    const payment = await paymentProvider.charge({ saleId, amountMinor: totalMinor, method: request.paymentMethod })
    if (!payment.approved) throw new Error('Оплата не подтверждена')

    const fiscal = await fiscalProvider.fiscalizeSale({
      saleId,
      amountMinor: totalMinor,
      paymentMethod: request.paymentMethod,
      lines: request.lines
    })

    database.saveSale({
      id: saleId,
      clientRequestId: request.clientRequestId,
      shiftId: shift.id,
      totalMinor,
      paymentMethod: request.paymentMethod,
      paymentTransactionId: payment.transactionId,
      fiscalNumber: fiscal.receiptNumber,
      createdAt: new Date().toISOString(),
      lines: request.lines
    })

    return { saleId, receiptNumber: fiscal.receiptNumber, totalMinor, queuedForSync: true }
  })
}
