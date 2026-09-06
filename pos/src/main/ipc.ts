import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { calculateTotalMinor } from '../shared/cart'
import type { BootState, CompleteSaleRequest, CompleteSaleResult, ConnectionConfig, HeldReceipt, Shift } from '../shared/contracts'
import { ConnectionStore } from './connection'
import { PosDatabase } from './database'
import { loadBootstrap } from './frappe'
import type { FiscalProvider, PaymentProvider } from './providers/contracts'

const demoRules = { allowDiscounts:true,maxDiscountPercent:100,acceptsCash:true,acceptsCard:true,acceptsQr:false }

export function registerIpcHandlers(dependencies: {
  database: PosDatabase
  connectionStore: ConnectionStore
  paymentProvider: PaymentProvider
  fiscalProvider: FiscalProvider
}): void {
  const { database, connectionStore, paymentProvider, fiscalProvider } = dependencies
  const cashierName = 'Администратор'

  const bootState=():BootState=>{
    const cached=database.getState('bootstrap')
    const remote=cached ? JSON.parse(cached) as Partial<BootState> : {}
    return {
      pointId:remote.pointId ?? 'demo-point',
      pointName:remote.pointName ?? 'Тестовая точка',
      workstationName:remote.workstationName ?? 'Касса 1',
      cashierName:remote.cashierName ?? cashierName,
      online:Boolean(remote.online),
      pendingSync:database.pendingSyncCount(),
      lastSyncAt:remote.lastSyncAt,
      source:remote.source ?? 'demo',
      shift:database.currentShift(),
      rules:remote.rules ?? demoRules
    }
  }

  ipcMain.handle('pos:get-boot-state', bootState)
  ipcMain.handle('pos:list-products', () => database.listProducts())
  ipcMain.handle('pos:list-customers', (_event,query?:string) => database.listCustomers(query))
  ipcMain.handle('pos:list-sales', () => database.listSales())
  ipcMain.handle('pos:list-held-receipts', () => database.listHeldReceipts())
  ipcMain.handle('pos:hold-receipt', (_event,input:Omit<HeldReceipt,'id'|'createdAt'>) => database.holdReceipt(input))
  ipcMain.handle('pos:delete-held-receipt', (_event,id:string) => database.deleteHeldReceipt(id))
  ipcMain.handle('pos:get-shift-summary', () => database.getShiftSummary())

  ipcMain.handle('pos:open-shift', (): Shift => database.openShift({
    id: randomUUID(), openedAt: new Date().toISOString(), cashierName:bootState().cashierName
  }))
  ipcMain.handle('pos:close-shift', () => database.closeShift())

  ipcMain.handle('pos:get-connection-status', () => connectionStore.status(bootState().lastSyncAt,database.getState('sync_error')))
  ipcMain.handle('pos:save-connection', (_event,config:ConnectionConfig) => {
    connectionStore.save(config)
    database.setState('sync_error','')
    return connectionStore.status(bootState().lastSyncAt)
  })
  ipcMain.handle('pos:sync-now', async ():Promise<BootState> => {
    const config=connectionStore.load()
    if(!config) throw new Error('Сначала заполните подключение к Распечатка OS')
    try {
      const remote=await loadBootstrap(config)
      database.replaceProducts(remote.products)
      const lastSyncAt=new Date().toISOString()
      database.setState('bootstrap',JSON.stringify({
        pointId:remote.point.id,pointName:remote.point.name,workstationName:remote.workplace.name,
        cashierName:remote.employee.name,online:true,lastSyncAt,source:'frappe',rules:remote.rules
      }))
      database.setState('sync_error','')
      return bootState()
    } catch(error) {
      const message=error instanceof Error ? error.message : String(error)
      database.setState('sync_error',message)
      const current=bootState()
      database.setState('bootstrap',JSON.stringify({...current,online:false}))
      throw error
    }
  })

  ipcMain.handle('pos:complete-sale', async (_event, request: CompleteSaleRequest): Promise<CompleteSaleResult> => {
    const existing = database.findSaleByClientRequestId(request.clientRequestId)
    if (existing) return { ...existing, changeMinor:0, queuedForSync:true }
    const shift = database.currentShift()
    if (!shift) throw new Error('Сначала откройте смену')
    if (!request.lines.length) throw new Error('Чек пуст')
    const rules=bootState().rules
    const discount=Math.min(request.receiptDiscountPercent ?? 0,rules.maxDiscountPercent)
    const totalMinor = calculateTotalMinor(request.lines,rules.allowDiscounts ? discount : 0)
    if(request.paymentMethod==='cash' && (request.cashReceivedMinor ?? 0)<totalMinor) throw new Error('Получено наличными меньше суммы чека')
    const saleId = randomUUID()
    const payment = await paymentProvider.charge({ saleId, amountMinor: totalMinor, method: request.paymentMethod })
    if (!payment.approved) throw new Error('Оплата не подтверждена')
    const fiscal = await fiscalProvider.fiscalizeSale({ saleId, amountMinor: totalMinor, paymentMethod: request.paymentMethod, lines: request.lines })
    database.saveSale({
      id:saleId,clientRequestId:request.clientRequestId,shiftId:shift.id,totalMinor,
      paymentMethod:request.paymentMethod,paymentTransactionId:payment.transactionId,
      fiscalNumber:fiscal.receiptNumber,createdAt:new Date().toISOString(),
      customerName:request.customer?.name,lines:request.lines
    })
    return {
      saleId,receiptNumber:fiscal.receiptNumber,totalMinor,
      changeMinor:request.paymentMethod==='cash' ? (request.cashReceivedMinor ?? totalMinor)-totalMinor : 0,
      queuedForSync:true
    }
  })
}
