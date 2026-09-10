import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { calculateTotalMinor } from '../shared/cart'
import type {
  BootState, CashOperationType, CompleteSaleRequest, CompleteSaleResult, ConnectionConfig,
  CashCount, CashCountLine, CreateReturnRequest, HeldReceipt, PaymentPart, PrintKind,
  ReturnResult, Shift, StockWriteOffRequest, SupplyRequestInput, CreateUnpaidOrderRequest, UpdateOrderRequest
} from '../shared/contracts'
import { ConnectionStore } from './connection'
import { PosDatabase } from './database'
import type { FiscalProvider, PaymentProvider, PrintProvider } from './providers/contracts'
import { buildBootState, performSync } from './sync'
import { PosTransactionEngine } from './transaction-engine'

const accepted=(rules:BootState['rules'],method:PaymentPart['method'])=>
  method==='cash'?rules.acceptsCash:
  method==='card'?rules.acceptsCard:
  method==='qr'?rules.acceptsQr:
  method==='remote_payment'?(rules.acceptsRemotePayment!==false):false

export function registerIpcHandlers(dependencies:{
  database:PosDatabase
  connectionStore:ConnectionStore
  paymentProvider:PaymentProvider
  fiscalProvider:FiscalProvider
  printProvider:PrintProvider
  transactionEngine:PosTransactionEngine
}):void {
  const {database,connectionStore,paymentProvider,fiscalProvider,printProvider,transactionEngine}=dependencies
  const bootState=()=>buildBootState(database)

  ipcMain.handle('pos:get-boot-state',bootState)
  ipcMain.handle('pos:list-products',()=>database.listProducts())
  ipcMain.handle('pos:list-customers',(_event,query?:string)=>database.listCustomers(query))
  ipcMain.handle('pos:list-sales',()=>database.listSales())
  ipcMain.handle('pos:get-sale',(_event,id:string)=>database.getSale(id))
  ipcMain.handle('pos:list-returns',()=>database.listReturns())
  ipcMain.handle('pos:print-sale',async(_event,id:string,kind:PrintKind)=>{
    const sale=database.getSale(id)
    if(kind==='fiscal-copy')return fiscalProvider.reprintReceipt({saleId:sale.id,receiptNumber:sale.receiptNumber})
    return printProvider.printCommodityReceipt(sale,bootState())
  })
  ipcMain.handle('pos:list-printers',()=>printProvider.listPrinters())
  ipcMain.handle('pos:get-selected-printer',()=>printProvider.getSelectedPrinter())
  ipcMain.handle('pos:set-selected-printer',(_event,name:string)=>printProvider.setSelectedPrinter(name))
  ipcMain.handle('pos:get-device-statuses',async()=>({
    fiscal:await fiscalProvider.healthCheck(),
    payment:await paymentProvider.healthCheck(),
    printer:await printProvider.healthCheck()
  }))
  ipcMain.handle('pos:list-unresolved-operations',()=>transactionEngine.listUnresolved())
  ipcMain.handle('pos:recover-operation',(_event,id:string)=>transactionEngine.recover(id))

  ipcMain.handle('pos:list-held-receipts',()=>database.listHeldReceipts())
  ipcMain.handle('pos:hold-receipt',(_event,input:Omit<HeldReceipt,'id'|'createdAt'>)=>database.holdReceipt(input))
  ipcMain.handle('pos:delete-held-receipt',(_event,id:string)=>database.deleteHeldReceipt(id))
  ipcMain.handle('pos:get-shift-summary',()=>database.getShiftSummary())
  ipcMain.handle('pos:list-cash-operations',()=>database.listCashOperations())
  ipcMain.handle('pos:add-cash-operation',(_event,type:CashOperationType,amountMinor:number,reason:string)=>database.addCashOperation(type,amountMinor,reason))
  ipcMain.handle('pos:get-workplace-data',()=>database.getWorkplaceData())
  ipcMain.handle('pos:report-stock-write-off',(_event,request:StockWriteOffRequest)=>database.reportStockWriteOff(request))
  ipcMain.handle('pos:create-supply-request',(_event,request:SupplyRequestInput)=>database.createSupplyRequest(request))
  ipcMain.handle('pos:record-cleaner-visit',()=>database.recordCleanerVisit(bootState().cashierName))
  ipcMain.handle('pos:pay-cleaner',(_event,amountMinor:number)=>database.payCleaner(amountMinor))
  ipcMain.handle('pos:save-cash-count',(_event,countType:CashCount['countType'],lines:CashCountLine[])=>database.saveCashCount(countType,lines))
  ipcMain.handle('pos:get-last-cash-count',()=>database.getLastCashCount())
  ipcMain.handle('pos:list-orders',()=>database.listOrders())
  ipcMain.handle('pos:create-unpaid-order',(_event,request:CreateUnpaidOrderRequest)=>database.createUnpaidOrder(request))
  ipcMain.handle('pos:update-order',(_event,request:UpdateOrderRequest)=>database.updateOrder(request))

  ipcMain.handle('pos:open-shift',async():Promise<Shift>=>{
    const current=database.currentShift();if(current)return current
    const fiscalHealth=await fiscalProvider.healthCheck()
    if(!fiscalHealth.ready)throw new Error(`ККТ не готова: ${fiscalHealth.message}`)
    const fiscalShift=await fiscalProvider.getShiftStatus()
    if(!fiscalShift.open)await fiscalProvider.openShift()
    return database.openShift({id:randomUUID(),openedAt:new Date().toISOString(),cashierName:bootState().cashierName})
  })
  ipcMain.handle('pos:close-shift',async()=>{
    if(transactionEngine.listUnresolved().length)throw new Error('Нельзя закрыть смену: есть незавершённые операции. Сначала завершите их в «Восстановлении».')
    const current=database.currentShift();if(!current)throw new Error('Нет открытой смены')
    const fiscalHealth=await fiscalProvider.healthCheck()
    if(!fiscalHealth.ready)throw new Error(`ККТ не готова к закрытию смены: ${fiscalHealth.message}`)
    const fiscalShift=await fiscalProvider.getShiftStatus()
    if(fiscalShift.open)await fiscalProvider.closeShift()
    return database.closeShift()
  })

  ipcMain.handle('pos:get-connection-status',()=>connectionStore.status(bootState().lastSyncAt,database.getState('sync_error')))
  ipcMain.handle('pos:save-connection',(_event,config:ConnectionConfig)=>{
    connectionStore.save(config);database.setState('sync_error','')
    return connectionStore.status(bootState().lastSyncAt)
  })
  ipcMain.handle('pos:sync-now',()=>performSync(database,connectionStore))

  ipcMain.handle('pos:complete-sale',async(_event,request:CompleteSaleRequest):Promise<CompleteSaleResult>=>{
    const existing=database.findSaleByClientRequestId(request.clientRequestId)
    if(existing)return {...existing,changeMinor:0,queuedForSync:true}
    const shift=database.currentShift();if(!shift)throw new Error('Сначала откройте смену')
    if(!request.lines.length)throw new Error('Чек пуст')
    const rules=bootState().rules
    const discount=Math.min(request.receiptDiscountPercent??0,rules.maxDiscountPercent)
    const totalMinor=calculateTotalMinor(request.lines,rules.allowDiscounts?discount:0)
    const catalog=new Map(database.listProducts().map((x)=>[x.id,x]))
    for(const line of request.lines){
      const product=catalog.get(line.productId)
      if(!product){
        if(!rules.allowFreePrice)throw new Error('Свободная цена запрещена на этой точке')
        continue
      }
      if(product.preventDiscounts&&(line.discountPercent||discount))throw new Error(`Для «${product.name}» скидка запрещена`)
      if(line.unitPriceMinor<(product.minimumSalePriceMinor??0))throw new Error(`Цена «${product.name}» ниже минимальной`)
    }
    if(!request.payments.length||request.payments.some((x)=>!accepted(rules,x.method)))throw new Error('Способ оплаты недоступен на этой точке')
    if(request.payments.some((x)=>!Number.isInteger(x.amountMinor)||x.amountMinor<=0))throw new Error('Некорректная сумма оплаты')
    if(request.payments.reduce((sum,x)=>sum+x.amountMinor,0)!==totalMinor)throw new Error('Сумма оплат должна совпадать с итогом чека')
    const cashAmount=request.payments.find((x)=>x.method==='cash')?.amountMinor??0
    if(cashAmount&&(request.cashReceivedMinor??cashAmount)<cashAmount)throw new Error('Получено наличными меньше суммы наличной оплаты')
    return transactionEngine.completeSale({...request,receiptDiscountPercent:discount},shift.id,totalMinor)
  })

  ipcMain.handle('pos:create-return',async(_event,request:CreateReturnRequest):Promise<ReturnResult>=>{
    const existing=database.findReturnByClientRequestId(request.clientRequestId)
    if(existing)return {...existing,queuedForSync:true}
    const shift=database.currentShift();if(!shift)throw new Error('Сначала откройте смену')
    const sale=database.getSale(request.saleId)
    if(!request.lines.length)throw new Error('Выберите хотя бы одну позицию')
    const lines=request.lines.map((requested)=>{
      const original=sale.lines.find((x)=>x.id===requested.saleItemId)
      if(!original)throw new Error('Позиция исходного чека не найдена')
      const available=original.quantity-original.returnedQuantity
      if(requested.quantity<=0||requested.quantity>available)throw new Error(`Для «${original.name}» доступно к возврату: ${available}`)
      const originalLineTotal=Math.round(original.quantity*original.unitPriceMinor*(1-(original.discountPercent??0)/100))
      const paidLineTotal=Math.round(sale.totalMinor*originalLineTotal/
        (sale.lines.reduce((sum,x)=>sum+Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent??0)/100)),0)||1))
      return {...requested,lineTotalMinor:Math.round(paidLineTotal*requested.quantity/original.quantity)}
    })
    const totalMinor=lines.reduce((sum,x)=>sum+x.lineTotalMinor,0)
    if(request.payments.some((x)=>!accepted(bootState().rules,x.method)))throw new Error('Способ возврата недоступен на этой точке')
    if(request.payments.reduce((sum,x)=>sum+x.amountMinor,0)!==totalMinor)throw new Error('Сумма возврата по способам оплаты не совпадает с итогом')
    return transactionEngine.createReturn(request,shift.id,totalMinor,sale)
  })
}
