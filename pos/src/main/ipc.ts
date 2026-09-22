import { ipcMain } from 'electron'
import { calculateDiscountBreakdown } from '../shared/cart'
import type {
  BootState, CashOperationType, CompleteSaleRequest, CompleteSaleResult, ConnectionConfig,
  CashCount, CashCountLine, CreateReturnRequest, HeldReceipt, PaymentPart, PrintKind,
  ReturnResult, SaleDetails, Shift, StockReceiptRequest, StockWriteOffRequest, SupplyRequestInput, CreateUnpaidOrderRequest, UpdateOrderRequest, CreateOrderFromSaleRequest
} from '../shared/contracts'
import { ConnectionStore } from './connection'
import { PosDatabase } from './database'
import { PosDiagnostics } from './diagnostics'
import { CommodityPrintQueue } from './print-jobs'
import type { FiscalProvider, PaymentProvider, PrintProvider } from './providers/contracts'
import { ShiftCoordinator } from './shift-coordinator'
import { buildBootState, performConfigurationSync, performSync } from './sync'
import { PosTransactionEngine } from './transaction-engine'
import { CashierAuthSession } from './cashier-auth'
import { PosLifecycleStore } from './pos-lifecycle'
import { getPointReceipt } from './frappe'

export const connectionIdentityChanged=(previous:ConnectionConfig|undefined,next:ConnectionConfig):boolean=>{
  if(!previous)return false
  const normalizeServer=(value?:string)=>value?.trim().replace(/\/+$/,'')??''
  return normalizeServer(previous.serverUrl)!==normalizeServer(next.serverUrl)
    ||(previous.deviceId??'')!==(next.deviceId??'')
}

export function assertConnectionIdentityChangeAllowed(
  previous:ConnectionConfig|undefined,
  next:ConnectionConfig,
  hasOpenShift:boolean
):boolean{
  const changed=connectionIdentityChanged(previous,next)
  if(changed&&hasOpenShift)throw new Error('Нельзя изменить подключение к точке во время открытой смены')
  return changed
}

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
  cashierAuth:CashierAuthSession
  lifecycle:PosLifecycleStore
}):void {
  const {database,connectionStore,paymentProvider,fiscalProvider,printProvider,printQueue,transactionEngine,shiftCoordinator,diagnostics,cashierAuth,lifecycle}=dependencies
  const bootState=()=>{
    const boot=buildBootState(database)
    const auth=cashierAuth.state()
    return {...boot,cashierId:auth.employee?.id,cashierName:auth.employee?.name||'Выберите сотрудника',accessRevoked:Boolean(auth.employee)&&!boot.employees.some((row)=>row.id===auth.employee?.id)}
  }
  const assertCashierAccess=()=>cashierAuth.requireAuthenticated()

  const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error)
  const assertFiscalShiftReady=async(action:string)=>{
    const fiscalShift=await fiscalProvider.getShiftStatus()
    if(!fiscalShift.open)throw new Error(`Нельзя ${action}: фискальная смена АТОЛ закрыта. Откройте смену кассы.`)
    if(fiscalShift.state==='expired')throw new Error(`Нельзя ${action}: фискальная смена АТОЛ истекла. Закройте текущую смену и откройте новую.`)
    return fiscalShift
  }

  ipcMain.handle('pos:get-boot-state',bootState)
  ipcMain.handle('pos:set-upsell-cursor',(_event,triggerItem:string,cursor:number)=>{
    database.setUpsellCursor(triggerItem,cursor)
  })
  ipcMain.handle('pos:get-pos-lifecycle',()=>lifecycle.status())
  ipcMain.handle('pos:begin-initial-setup',()=>lifecycle.beginConfiguration())
  ipcMain.handle('pos:complete-initial-setup',async()=>{
    lifecycle.beginConfiguration()
    await performConfigurationSync(database,connectionStore)
    const status=lifecycle.markReady()
    diagnostics.record({source:'app',eventType:'lifecycle.ready',message:'Первоначальная настройка POS завершена'})
    return status
  })
  ipcMain.handle('pos:list-products',()=>database.listProducts())
  ipcMain.handle('pos:list-customers',(_event,query?:string)=>database.listCustomers(query))
  ipcMain.handle('pos:get-customer',(_event,id:string)=>database.getCustomer(id))
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
  ipcMain.handle('pos:print-point-receipt-commodity',async(_event,id:string)=>{
    assertCashierAccess()
    const config=connectionStore.load()
    if(!config)throw new Error('Касса не подключена к Распечатка OS')
    const receipt=await getPointReceipt(config,id)
    if(receipt.receiptType!=='Sale')throw new Error('Товарный чек можно печатать только для продажи')
    const methods=receipt.payments.map((payment)=>payment.method).filter(Boolean) as NonNullable<(typeof receipt.payments)[number]['method']>[]
    const unique=[...new Set(methods)]
    const sale:SaleDetails={
      id:'server:'+receipt.id,receiptNumber:receipt.receiptNumber,totalMinor:receipt.totalMinor,returnedMinor:0,
      paymentMethod:unique.length===1?unique[0]:'mixed',paymentMethods:unique,
      customerName:receipt.customerName,customerPhone:receipt.customerPhone,cashierId:receipt.cashierId,cashierName:receipt.cashierName,
      shiftId:receipt.shiftExternalId,createdAt:receipt.createdAt,status:'completed',returnable:false,source:'server',
      lines:receipt.lines.map((line,index)=>({
        id:index,productId:line.productId||('server-line-'+index),name:line.name,quantity:line.quantity,
        unitPriceMinor:line.unitPriceMinor,discountPercent:line.discountPercent,returnedQuantity:line.returnedQuantity??0
      })),
      payments:receipt.payments.filter((payment)=>payment.method).map((payment)=>({
        method:payment.method!,amountMinor:payment.amountMinor,transactionId:payment.transactionId
      }))
    }
    diagnostics.record({source:'printer',eventType:'receipt.reprint_started',message:`Печать товарного чека ${receipt.receiptNumber} из server snapshot`,operationId:receipt.id,details:{kind:'commodity',source:'server'}})
    try{
      const boot=bootState()
      const result=await printProvider.printCommodityReceipt(sale,{...boot,cashierName:receipt.cashierName||boot.cashierName})
      diagnostics.record({source:'printer',eventType:'receipt.reprint_completed',message:result.message,operationId:receipt.id,details:{kind:'commodity',source:'server'}})
      return result
    }catch(error){
      diagnostics.record({source:'printer',level:'error',eventType:'receipt.reprint_failed',message:errorMessage(error),operationId:receipt.id,details:{kind:'commodity',source:'server'}})
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
  ipcMain.handle('pos:hold-receipt',(_event,input:Omit<HeldReceipt,'id'|'createdAt'>)=>{assertCashierAccess();return database.holdReceipt(input)})
  ipcMain.handle('pos:delete-held-receipt',(_event,id:string)=>database.deleteHeldReceipt(id))
  ipcMain.handle('pos:get-shift-summary',()=>database.getShiftSummary())
  ipcMain.handle('pos:list-cash-operations',()=>database.listCashOperations())
  ipcMain.handle('pos:add-cash-operation',(_event,type:CashOperationType,amountMinor:number,reason:string)=>{assertCashierAccess();return database.addCashOperation(type,amountMinor,reason)})
  ipcMain.handle('pos:get-workplace-data',()=>database.getWorkplaceData())
  ipcMain.handle('pos:report-stock-write-off',(_event,request:StockWriteOffRequest)=>{const cashier=assertCashierAccess();return database.reportStockWriteOff(request,cashier.id)})
  ipcMain.handle('pos:create-supply-request',(_event,request:SupplyRequestInput)=>{const cashier=assertCashierAccess();return database.createSupplyRequest(request,cashier.id)})
  ipcMain.handle('pos:create-stock-receipt',(_event,request:StockReceiptRequest)=>{const cashier=assertCashierAccess();return database.createStockReceipt(request,cashier.id)})
  ipcMain.handle('pos:record-cleaner-visit',()=>database.recordCleanerVisit(assertCashierAccess().name))
  ipcMain.handle('pos:pay-cleaner',(_event,amountMinor:number)=>{assertCashierAccess();return database.payCleaner(amountMinor)})
  ipcMain.handle('pos:save-cash-count',(_event,countType:CashCount['countType'],lines:CashCountLine[])=>{assertCashierAccess();return database.saveCashCount(countType,lines)})
  ipcMain.handle('pos:get-last-cash-count',()=>database.getLastCashCount())
  ipcMain.handle('pos:list-orders',()=>database.listOrders())
  ipcMain.handle('pos:create-unpaid-order',(_event,request:CreateUnpaidOrderRequest)=>{const cashier=assertCashierAccess();return database.createUnpaidOrder(request,cashier.id)})
  ipcMain.handle('pos:create-order-from-sale',(_event,request:CreateOrderFromSaleRequest)=>{const cashier=assertCashierAccess();return database.createOrderFromSale(request,cashier.id)})
  ipcMain.handle('pos:update-order',(_event,request:UpdateOrderRequest)=>{const cashier=assertCashierAccess();return database.updateOrder(request,cashier.id)})

  ipcMain.handle('pos:open-shift',async():Promise<Shift>=>{
    const cashier=assertCashierAccess()
    diagnostics.record({source:'shift',eventType:'shift.open_started',message:'Начинаем открытие локальной и фискальной смены'})
    try{
      const shift=await shiftCoordinator.openShift(cashier.id,cashier.name)
      diagnostics.record({source:'shift',eventType:'shift.open_completed',message:'Смена успешно открыта',operationId:shift.id})
      return shift
    }catch(error){
      diagnostics.record({source:'shift',level:'error',eventType:'shift.open_failed',message:errorMessage(error)})
      throw error
    }
  })
  ipcMain.handle('pos:close-shift',async()=>{
    const shift=database.currentShift()
    const cashier=cashierAuth.requireAuthenticated({allowRevokedForClose:true})
    if(!shift||(shift.cashierId?shift.cashierId!==cashier.id:shift.cashierName!==cashier.name))throw new Error('Закрыть смену может только открывший её кассир после входа по PIN')
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
      cashierAuth.logout()
      diagnostics.record({source:'shift',eventType:'shift.close_completed',message:'Смена успешно закрыта',operationId:shift?.id,details:{receipts:summary.receipts,revenueMinor:summary.revenueMinor}})
      return summary
    }catch(error){
      diagnostics.record({source:'shift',level:'error',eventType:'shift.close_failed',message:errorMessage(error),operationId:shift?.id})
      throw error
    }
  })

  ipcMain.handle('pos:get-connection-status',()=>connectionStore.status(bootState().lastSyncAt,database.getState('sync_error')))
  ipcMain.handle('pos:save-connection',(_event,config:ConnectionConfig)=>{
    if(lifecycle.status().state!=='READY')lifecycle.beginConfiguration()
    const previous=connectionStore.load()
    const identityChanged=assertConnectionIdentityChangeAllowed(previous??undefined,config,Boolean(database.currentShift()))
    if(identityChanged)database.clearConfirmedPointData()
    connectionStore.save(config);database.setState('sync_error','')
    diagnostics.record({source:'sync',eventType:'sync.connection_saved',message:'Настройки подключения к Raspechatka OS сохранены'})
    return connectionStore.status(bootState().lastSyncAt)
  })
  ipcMain.handle('pos:sync-configuration',async()=>{
    diagnostics.record({source:'sync',eventType:'sync.configuration_started',message:'Запущено обновление конфигурации и справочников'})
    try{
      const result=await performConfigurationSync(database,connectionStore)
      diagnostics.record({source:'sync',eventType:'sync.configuration_completed',message:'Конфигурация и справочники обновлены'})
      return result
    }catch(error){
      diagnostics.record({source:'sync',level:'warning',eventType:'sync.configuration_failed',message:errorMessage(error)})
      throw error
    }
  })
  ipcMain.handle('pos:sync-now',async()=>{
    const cashier=assertCashierAccess()
    if(transactionEngine.hasBlockingOperation())throw new Error('Синхронизация временно недоступна: завершите текущую оплату или восстановление операции')
    diagnostics.record({source:'sync',eventType:'sync.manual_started',message:'Запущена ручная синхронизация'})
    try{
      const result=await performSync(database,connectionStore,cashier.id)
      diagnostics.record({source:'sync',eventType:'sync.manual_completed',message:`Синхронизация завершена · к отправке ${result.pendingSync}`})
      return result
    }catch(error){
      diagnostics.record({source:'sync',level:'warning',eventType:'sync.manual_failed',message:errorMessage(error)})
      throw error
    }
  })

  ipcMain.handle('pos:complete-sale',async(_event,request:CompleteSaleRequest):Promise<CompleteSaleResult>=>{
    if(request.order&&(!request.order.phone?.replace(/\\D/g,'')||request.order.phone.replace(/\\D/g,'').length<5||!request.order.comment?.trim()||!request.order.dueAt))throw new Error('Телефон, описание и срок готовности заказа обязательны')
    lifecycle.requireReady()
    assertCashierAccess()
    const existing=database.findSaleByClientRequestId(request.clientRequestId)
    if(existing)return {...existing,changeMinor:0,queuedForSync:true}
    const shift=database.currentShift();if(!shift)throw new Error('Сначала откройте смену')
    if(!request.lines.length)throw new Error('Чек пуст')
    const boot=bootState()
    const rules=boot.rules
    const catalog=new Map(database.listProducts().map((x)=>[x.id,x]))
    const verifiedLines=request.lines.map((line)=>{
      const product=catalog.get(line.productId)
      if(!product)throw new Error(`Позиция «${line.name}» отсутствует в актуальном каталоге`)
      if(line.unitPriceMinor!==product.priceMinor&&!rules.allowFreePrice)throw new Error(`Изменение цены «${product.name}» запрещено на этой точке`)
      if(line.unitPriceMinor<(product.minimumSalePriceMinor??0))throw new Error(`Цена «${product.name}» ниже минимальной`)
      return {...line,catalogUnitPriceMinor:product.priceMinor,preventDiscounts:Boolean(product.preventDiscounts)}
    })
    const discountRules={
      allowDiscounts:rules.allowDiscounts,
      maxDiscountPercent:rules.maxDiscountPercent,
      reviewDiscountPerReviewMinor:rules.reviewDiscountPerReviewMinor??0,
    }
    const breakdown=calculateDiscountBreakdown(
      verifiedLines,discountRules,request.clubDiscountPercent??0,request.reviewCount??0,request.manualDiscount,
    )
    const totalMinor=breakdown.totalMinor
    if(!request.payments.length||request.payments.some((x)=>!accepted(rules,x.method)))throw new Error('Способ оплаты недоступен на этой точке')
    if(request.payments.some((x)=>!Number.isInteger(x.amountMinor)||x.amountMinor<=0))throw new Error('Некорректная сумма оплаты')
    if(request.payments.reduce((sum,x)=>sum+x.amountMinor,0)!==totalMinor)throw new Error('Сумма оплат должна совпадать с итогом чека')
    const cashAmount=request.payments.find((x)=>x.method==='cash')?.amountMinor??0
    if(cashAmount&&(request.cashReceivedMinor??cashAmount)<cashAmount)throw new Error('Получено наличными меньше суммы наличной оплаты')
    if(request.order){
      if(request.order.phone.trim().replace(/\D/g,'').length<5)throw new Error('Укажите корректный телефон заказа')
      if(!request.order.comment?.trim())throw new Error('Укажите описание заказа')
      if(!request.order.dueAt?.trim()||Number.isNaN(Date.parse(request.order.dueAt)))throw new Error('Укажите корректный срок готовности')
    }

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
      const result=await transactionEngine.completeSale({
        ...normalizedRequest,lines:verifiedLines,receiptDiscountPercent:breakdown.subtotalMinor>0?breakdown.totalDiscountMinor/breakdown.subtotalMinor*100:0,
        clubDiscountPercent:breakdown.clubDiscountPercent,reviewCount:breakdown.reviewCount,
        clubDiscountMinor:breakdown.clubDiscountMinor,reviewDiscountMinor:breakdown.reviewDiscountMinor,
        manualDiscountType:request.manualDiscount?.type??null,manualDiscountValue:request.manualDiscount?.value??0,
        manualDiscountMinor:breakdown.manualDiscountMinor,totalDiscountMinor:breakdown.totalDiscountMinor,
        discountRules,discountBreakdown:breakdown,
      },shift.id,totalMinor)
      diagnostics.record({source:'fiscal',eventType:'sale.completed',message:`Продажа завершена, чек ${result.receiptNumber}`,operationId:request.clientRequestId,details:{saleId:result.saleId,totalMinor}})
      return result
    }catch(error){
      diagnostics.record({source:'fiscal',level:'error',eventType:'sale.failed',message:errorMessage(error),operationId:request.clientRequestId,details:{totalMinor}})
      throw error
    }
  })

  ipcMain.handle('pos:create-return',async(_event,request:CreateReturnRequest):Promise<ReturnResult>=>{
    assertCashierAccess()
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
