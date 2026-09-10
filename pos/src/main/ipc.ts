import { ipcMain } from 'electron'
import { calculateTotalMinor } from '../shared/cart'
import type {
  BootState, CashOperationType, CompleteSaleRequest, CompleteSaleResult, ConnectionConfig,
  CashCount, CashCountLine, CreateReturnRequest, HeldReceipt, PaymentPart, PrintKind,
  ReturnResult, Shift, StockWriteOffRequest, SupplyRequestInput, CreateUnpaidOrderRequest, UpdateOrderRequest
} from '../shared/contracts'
import { ConnectionStore } from './connection'
import { PosDatabase } from './database'
import { PosDiagnostics } from './diagnostics'
import { CommodityPrintQueue } from './print-jobs'
import type { FiscalProvider, PaymentProvider, PrintProvider } from './providers/contracts'
import { ShiftCoordinator } from './shift-coordinator'
import { buildBootState, performSync } from './sync'
import { PosTransactionEngine } from './transaction-engine'

const accepted=(rules:BootState['rules'],method:PaymentPart['method'])=>
  method==='cash'?rules.acceptsCash:
  method==='card'?rules.acceptsCard:
  method==='qr'?rules.acceptsQr:
  method==='remote_payment'?(rules.acceptsRemotePayment!==false):false

const usesTerminal=(payments:PaymentPart[])=>payments.some((payment)=>payment.method==='card'||payment.method==='qr')

export function registerIpcHandlers(dependencies:{
  database:PosDatabase
  connectionStore:ConnectionStore
  paymentProvider:PaymentProvider
  fiscalProvider:FiscalProvider
  printProvider:PrintProvider
  printQueue:CommodityPrintQueue
  transactionEngine:PosTransactionEngine
  shiftCoordinator:ShiftCoordinator
  diagnostics:PosDiagnostics
}):void {
  const {database,connectionStore,paymentProvider,fiscalProvider,printProvider,printQueue,transactionEngine,shiftCoordinator,diagnostics}=dependencies
  const bootState=()=>buildBootState(database)

  const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error)
  const assertFiscalShiftReady=async(action:string)=>{
    const fiscalShift=await fiscalProvider.getShiftStatus()
    if(!fiscalShift.open)throw new Error(`Нельзя ${action}: фискальная смена АТОЛ закрыта. Откройте смену кассы.`)
    if(fiscalShift.state==='expired')throw new Error(`Нельзя ${action}: фискальная смена АТОЛ истекла. Закройте текущую смену и откройте новую.`)
    return fiscalShift
  }

  ipcMain.handle('pos:get-boot-state',bootState)
  ipcMain.handle('pos:list-products',()=>database.listProducts())
  ipcMain.handle('pos:list-customers',(_event,query?:string)=>database.listCustomers(query))
  ipcMain.handle('pos:list-sales',()=>database.listSales())
  ipcMain.handle('pos:get-sale',(_event,id:string)=>database.getSale(id))
  ipcMain.handle('pos:list-returns',()=>database.listReturns())
  ipcMain.handle('pos:print-sale',async(_event,id:string,kind:PrintKind)=>{
    const sale=database.getSale(id)
    diagnostics.record({source:kind==='fiscal-copy'?'fiscal':'printer',eventType:'receipt.reprint_started',message:`Повторная печать чека ${sale.receiptNumber}`,operationId:id,details:{kind}})
    try{
      const result=kind==='fiscal-copy'
        ?await fiscalProvider.reprintReceipt({saleId:sale.id,receiptNumber:sale.receiptNumber})
        :await printQueue.printSale(id)
      diagnostics.record({source:kind==='fiscal-copy'?'fiscal':'printer',eventType:'receipt.reprint_completed',message:result.message,operationId:id,details:{kind}})
      return result
    }catch(error){
      diagnostics.record({source:kind==='fiscal-copy'?'fiscal':'printer',level:'error',eventType:'receipt.reprint_failed',message:errorMessage(error),operationId:id,details:{kind}})
      throw error
    }
  })
  ipcMain.handle('pos:list-print-jobs',()=>printQueue.listPending())
  ipcMain.handle('pos:retry-print-job',async(_event,id:string)=>{
    diagnostics.record({source:'printer',eventType:'print.retry_started',message:'Повторная печать товарного чека',operationId:id})
    try{
      const result=await printQueue.retry(id)
      diagnostics.record({source:'printer',eventType:'print.retry_completed',message:result.message,operationId:id})
      return result
    }catch(error){
      diagnostics.record({source:'printer',level:'error',eventType:'print.retry_failed',message:errorMessage(error),operationId:id})
      throw error
    }
  })
  ipcMain.handle('pos:list-printers',()=>printProvider.listPrinters())
  ipcMain.handle('pos:get-selected-printer',()=>printProvider.getSelectedPrinter())
  ipcMain.handle('pos:set-selected-printer',async(_event,name:string)=>{
    await printProvider.setSelectedPrinter(name)
    diagnostics.record({source:'printer',eventType:'printer.selected',message:name?`Выбран товарный принтер: ${name}`:'Товарный принтер отключён'})
  })
  ipcMain.handle('pos:get-device-statuses',async()=>{
    const boot=bootState()
    let fiscalShiftOpen:boolean|undefined
    let fiscalShiftMessage='Состояние фискальной смены не проверено'
    let fiscalExpired=false
    try{
      const state=await fiscalProvider.getShiftStatus()
      fiscalShiftOpen=state.open
      fiscalExpired=state.state==='expired'
      fiscalShiftMessage=state.message
    }catch(error){
      fiscalShiftMessage=errorMessage(error)
    }
    const localOpen=Boolean(database.currentShift())
    const shiftReady=fiscalShiftOpen!==undefined&&localOpen===fiscalShiftOpen&&!fiscalExpired
    const [fiscal,payment,printer]=await Promise.all([
      fiscalProvider.healthCheck(),paymentProvider.healthCheck(),printProvider.healthCheck()
    ])
    return {
      os:{
        ready:boot.online,
        status:boot.online?'ready':'offline',
        message:boot.online?`OS на связи · к отправке ${boot.pendingSync}`:`Локальный режим · к отправке ${boot.pendingSync}`,
        details:{pendingSync:boot.pendingSync,lastSyncAt:boot.lastSyncAt}
      },
      fiscal,
      payment,
      printer,
      shift:{
        ready:shiftReady,
        localOpen,
        fiscalOpen:fiscalShiftOpen,
        message:fiscalExpired
          ?'Фискальная смена АТОЛ истекла — продажи заблокированы до закрытия и открытия новой смены'
          :fiscalShiftOpen===undefined
            ?`ККТ: ${fiscalShiftMessage}`
            :localOpen===fiscalShiftOpen
              ?(localOpen?'Локальная и фискальная смены открыты':'Локальная и фискальная смены закрыты')
              :`Несоответствие смен: локальная ${localOpen?'открыта':'закрыта'}, ККТ ${fiscalShiftOpen?'открыта':'закрыта'}`
      }
    }
  })
  ipcMain.handle('pos:list-unresolved-operations',()=>transactionEngine.listUnresolved())
  ipcMain.handle('pos:recover-operation',async(_event,id:string)=>{
    diagnostics.record({source:'recovery',level:'warning',eventType:'operation.recovery_started',message:'Начата проверка незавершённой операции',operationId:id})
    try{
      const result=await transactionEngine.recover(id)
      diagnostics.record({source:'recovery',level:result.status==='completed'?'info':'warning',eventType:'operation.recovery_result',message:result.message,operationId:id})
      return result
    }catch(error){
      diagnostics.record({source:'recovery',level:'error',eventType:'operation.recovery_failed',message:errorMessage(error),operationId:id})
      throw error
    }
  })
  ipcMain.handle('pos:list-diagnostic-events',(_event,limit?:number)=>diagnostics.list(limit))

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
    diagnostics.record({source:'shift',eventType:'shift.open_started',message:'Начинаем открытие локальной и фискальной смены'})
    try{
      const shift=await shiftCoordinator.openShift(bootState().cashierName)
      diagnostics.record({source:'shift',eventType:'shift.open_completed',message:'Смена успешно открыта',operationId:shift.id})
      return shift
    }catch(error){
      diagnostics.record({source:'shift',level:'error',eventType:'shift.open_failed',message:errorMessage(error)})
      throw error
    }
  })
  ipcMain.handle('pos:close-shift',async()=>{
    const shift=database.currentShift()
    diagnostics.record({source:'shift',eventType:'shift.close_started',message:'Начинаем закрытие локальной и фискальной смены',operationId:shift?.id})
    try{
      const shiftSummary=database.getShiftSummary()
      if(shiftSummary.cardMinor+shiftSummary.qrMinor>0){
        const paymentHealth=await paymentProvider.healthCheck()
        if(paymentHealth.status==='not_configured')throw new Error('Нельзя закрыть смену с безналичными оплатами: эквайринг INPAS не настроен для сверки итогов.')
        diagnostics.record({source:'payment',eventType:'payment.reconcile_started',message:'Сверка итогов INPAS перед закрытием смены',operationId:shift?.id})
        const reconciliation=await paymentProvider.reconcile()
        diagnostics.record({source:'payment',eventType:'payment.reconcile_completed',message:reconciliation.message,operationId:shift?.id})
      }
      const summary=await shiftCoordinator.closeShift(transactionEngine.listUnresolved().length>0)
      diagnostics.record({source:'shift',eventType:'shift.close_completed',message:'Смена успешно закрыта',operationId:shift?.id,details:{receipts:summary.receipts,revenueMinor:summary.revenueMinor}})
      return summary
    }catch(error){
      diagnostics.record({source:'shift',level:'error',eventType:'shift.close_failed',message:errorMessage(error),operationId:shift?.id})
      throw error
    }
  })

  ipcMain.handle('pos:get-connection-status',()=>connectionStore.status(bootState().lastSyncAt,database.getState('sync_error')))
  ipcMain.handle('pos:save-connection',(_event,config:ConnectionConfig)=>{
    connectionStore.save(config);database.setState('sync_error','')
    diagnostics.record({source:'sync',eventType:'sync.connection_saved',message:'Настройки подключения к Raspechatka OS сохранены'})
    return connectionStore.status(bootState().lastSyncAt)
  })
  ipcMain.handle('pos:sync-now',async()=>{
    diagnostics.record({source:'sync',eventType:'sync.manual_started',message:'Запущена ручная синхронизация'})
    try{
      const result=await performSync(database,connectionStore)
      diagnostics.record({source:'sync',eventType:'sync.manual_completed',message:`Синхронизация завершена · к отправке ${result.pendingSync}`})
      return result
    }catch(error){
      diagnostics.record({source:'sync',level:'warning',eventType:'sync.manual_failed',message:errorMessage(error)})
      throw error
    }
  })

  ipcMain.handle('pos:complete-sale',async(_event,request:CompleteSaleRequest):Promise<CompleteSaleResult>=>{
    const existing=database.findSaleByClientRequestId(request.clientRequestId)
    if(existing)return {...existing,changeMinor:0,queuedForSync:true}
    const shift=database.currentShift();if(!shift)throw new Error('Сначала откройте смену')
    if(!request.lines.length)throw new Error('Чек пуст')
    const boot=bootState()
    const rules=boot.rules
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

    const hasRemote=request.payments.some((x)=>x.method==='remote_payment')
    if(hasRemote&&!request.remotePaymentConfirmation?.confirmed){
      throw new Error('Для удалённой оплаты кассир должен отдельно подтвердить, что получение денег проверено.')
    }
    const normalizedRequest:CompleteSaleRequest=hasRemote?{
      ...request,
      remotePaymentConfirmation:{
        confirmed:true,
        confirmedAt:new Date().toISOString(),
        confirmedBy:boot.cashierName,
        note:request.remotePaymentConfirmation?.note?.trim()||undefined
      }
    }:request

    const fiscalHealth=await fiscalProvider.healthCheck()
    if(!fiscalHealth.ready)throw new Error(`Нельзя принимать оплату: ККТ не готова. ${fiscalHealth.message}`)
    await assertFiscalShiftReady('проводить продажу')
    if(usesTerminal(request.payments)){
      const paymentHealth=await paymentProvider.healthCheck()
      if(!paymentHealth.ready)throw new Error(`Терминал оплаты не готов. ${paymentHealth.message}`)
    }

    diagnostics.record({
      source:usesTerminal(request.payments)?'payment':'fiscal',
      eventType:'sale.started',
      message:`Начата продажа на ${totalMinor/100} ₽`,
      operationId:request.clientRequestId,
      details:{totalMinor,payments:request.payments.map((x)=>x.method)}
    })
    try{
      const result=await transactionEngine.completeSale({...normalizedRequest,receiptDiscountPercent:discount},shift.id,totalMinor)
      diagnostics.record({source:'fiscal',eventType:'sale.completed',message:`Продажа завершена, чек ${result.receiptNumber}`,operationId:request.clientRequestId,details:{saleId:result.saleId,totalMinor}})
      try{
        await printQueue.printSale(result.saleId)
        diagnostics.record({source:'printer',eventType:'commodity_print.completed',message:'Товарный чек напечатан',operationId:request.clientRequestId})
        return result
      }catch(error){
        const message=errorMessage(error)
        diagnostics.record({source:'printer',level:'warning',eventType:'commodity_print.failed',message,operationId:request.clientRequestId,details:{saleId:result.saleId}})
        return {...result,commodityPrintWarning:message}
      }
    }catch(error){
      diagnostics.record({source:'fiscal',level:'error',eventType:'sale.failed',message:errorMessage(error),operationId:request.clientRequestId,details:{totalMinor}})
      throw error
    }
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
    if(request.payments.some((x)=>x.method==='remote_payment')){
      throw new Error('Автоматический возврат удалённой оплаты пока не поддерживается. Не фиксируем фиктивный возврат денег.')
    }

    const fiscalHealth=await fiscalProvider.healthCheck()
    if(!fiscalHealth.ready)throw new Error(`Нельзя начинать возврат: ККТ не готова. ${fiscalHealth.message}`)
    await assertFiscalShiftReady('оформлять возврат')
    if(usesTerminal(request.payments)){
      const paymentHealth=await paymentProvider.healthCheck()
      if(!paymentHealth.ready)throw new Error(`Терминал оплаты не готов к возврату. ${paymentHealth.message}`)
    }

    diagnostics.record({source:'fiscal',eventType:'return.started',message:`Начат возврат на ${totalMinor/100} ₽`,operationId:request.clientRequestId,details:{saleId:request.saleId,totalMinor}})
    try{
      const result=await transactionEngine.createReturn(request,shift.id,totalMinor,sale)
      diagnostics.record({source:'fiscal',eventType:'return.completed',message:`Возврат завершён, чек ${result.receiptNumber}`,operationId:request.clientRequestId,details:{returnId:result.returnId,totalMinor}})
      return result
    }catch(error){
      diagnostics.record({source:'fiscal',level:'error',eventType:'return.failed',message:errorMessage(error),operationId:request.clientRequestId,details:{saleId:request.saleId,totalMinor}})
      throw error
    }
  })
}
