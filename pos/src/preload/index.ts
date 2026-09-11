import { contextBridge, ipcRenderer } from 'electron'
import type { CashCount, CashCountLine, CashOperationType, CompleteSaleRequest, ConnectionConfig, CreateReturnRequest, CreateUnpaidOrderRequest, HeldReceipt, InpasSettings, PosApi, PrintKind, StockWriteOffRequest, SupplyRequestInput, UpdateOrderRequest } from '../shared/contracts'

type AtolSettings={enabled:boolean;baseUrl:string;taxationType:string;taxType:string;operatorName?:string}
type ShiftRecoveryStatus={pending:boolean;action?:'open'|'close';startedAt?:string;localOpen:boolean;fiscalOpen?:boolean;fiscalState?:'closed'|'opened'|'expired'|'unknown';safeToRecover:boolean;message:string}
type ExtendedPosApi=PosApi&{
  getAtolSettings:()=>Promise<AtolSettings>
  saveAtolSettings:(value:AtolSettings)=>Promise<AtolSettings>
  getShiftRecoveryStatus:()=>Promise<ShiftRecoveryStatus>
  recoverShiftState:()=>Promise<{recovered:boolean;pending:boolean;message?:string}>
  recordShiftDiscrepancy:(differenceMinor:number,note:string)=>Promise<unknown>
}

const cleanRemoteMessage=(error:unknown)=>{
  const raw=error instanceof Error?error.message:String(error)
  return raw
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i,'')
    .replace(/^Error:\s*/i,'')
    .trim()
}

const invokeShift=async<T>(channel:'pos:open-shift'|'pos:close-shift'):Promise<T>=>{
  try{return await ipcRenderer.invoke(channel) as T}
  catch(error){
    const message=cleanRemoteMessage(error)
    if(/fetch failed/i.test(message)){
      throw new Error('Нет связи с АТОЛ. Проверьте в «Настройках», что Драйвер ККТ и локальный Web Server запущены, затем повторите операцию со сменой.')
    }
    throw new Error(message||'Не удалось выполнить операцию со сменой')
  }
}

const api: ExtendedPosApi = {
  getBootState: () => ipcRenderer.invoke('pos:get-boot-state'),
  listProducts: () => ipcRenderer.invoke('pos:list-products'),
  listCustomers: (query) => ipcRenderer.invoke('pos:list-customers',query),
  listSales: () => ipcRenderer.invoke('pos:list-sales'),
  searchPointReceipts: (query) => ipcRenderer.invoke('pos:search-point-receipts',query),
  getSale: (id:string) => ipcRenderer.invoke('pos:get-sale',id),
  createReturn: (request:CreateReturnRequest) => ipcRenderer.invoke('pos:create-return',request),
  listReturns: () => ipcRenderer.invoke('pos:list-returns'),
  printSale: (id:string,kind:PrintKind) => ipcRenderer.invoke('pos:print-sale',id,kind),
  listPrintJobs: () => ipcRenderer.invoke('pos:list-print-jobs'),
  retryPrintJob: (id:string) => ipcRenderer.invoke('pos:retry-print-job',id),
  listPrinters: () => ipcRenderer.invoke('pos:list-printers'),
  getSelectedPrinter: () => ipcRenderer.invoke('pos:get-selected-printer'),
  setSelectedPrinter: (name:string) => ipcRenderer.invoke('pos:set-selected-printer',name),
  getDeviceStatuses: () => ipcRenderer.invoke('pos:get-device-statuses'),
  listUnresolvedOperations: () => ipcRenderer.invoke('pos:list-unresolved-operations'),
  recoverOperation: (id:string) => ipcRenderer.invoke('pos:recover-operation',id),
  listDiagnosticEvents: (limit?:number) => ipcRenderer.invoke('pos:list-diagnostic-events',limit),
  getAtolSettings:()=>ipcRenderer.invoke('pos:get-atol-settings'),
  saveAtolSettings:(value:AtolSettings)=>ipcRenderer.invoke('pos:save-atol-settings',value),
  getShiftRecoveryStatus:()=>ipcRenderer.invoke('pos:get-shift-recovery-status'),
  recoverShiftState:()=>ipcRenderer.invoke('pos:recover-shift-state'),
  recordShiftDiscrepancy:(differenceMinor:number,note:string)=>ipcRenderer.invoke('pos:record-shift-discrepancy',{differenceMinor,note}),
  getInpasSettings:()=>ipcRenderer.invoke('pos:get-inpas-settings'),
  saveInpasSettings:(value:InpasSettings)=>ipcRenderer.invoke('pos:save-inpas-settings',value),
  testPaymentTerminal:()=>ipcRenderer.invoke('pos:test-payment-terminal'),
  reconcilePaymentTerminal:()=>ipcRenderer.invoke('pos:reconcile-payment-terminal'),
  listHeldReceipts: () => ipcRenderer.invoke('pos:list-held-receipts'),
  holdReceipt: (receipt:Omit<HeldReceipt,'id'|'createdAt'>) => ipcRenderer.invoke('pos:hold-receipt',receipt),
  deleteHeldReceipt: (id:string) => ipcRenderer.invoke('pos:delete-held-receipt',id),
  openShift: () => invokeShift('pos:open-shift'),
  closeShift: () => invokeShift('pos:close-shift'),
  getShiftSummary: () => ipcRenderer.invoke('pos:get-shift-summary'),
  listCashOperations: () => ipcRenderer.invoke('pos:list-cash-operations'),
  addCashOperation: (type:CashOperationType,amountMinor:number,reason:string) => ipcRenderer.invoke('pos:add-cash-operation',type,amountMinor,reason),
  getWorkplaceData: () => ipcRenderer.invoke('pos:get-workplace-data'),
  reportStockWriteOff: (request:StockWriteOffRequest) => ipcRenderer.invoke('pos:report-stock-write-off',request),
  createSupplyRequest: (request:SupplyRequestInput) => ipcRenderer.invoke('pos:create-supply-request',request),
  recordCleanerVisit: () => ipcRenderer.invoke('pos:record-cleaner-visit'),
  payCleaner: (amountMinor:number) => ipcRenderer.invoke('pos:pay-cleaner',amountMinor),
  saveCashCount: (countType:CashCount['countType'],lines:CashCountLine[]) => ipcRenderer.invoke('pos:save-cash-count',countType,lines),
  getLastCashCount: () => ipcRenderer.invoke('pos:get-last-cash-count'),
  listOrders: () => ipcRenderer.invoke('pos:list-orders'),
  createUnpaidOrder: (request:CreateUnpaidOrderRequest) => ipcRenderer.invoke('pos:create-unpaid-order',request),
  updateOrder: (request:UpdateOrderRequest) => ipcRenderer.invoke('pos:update-order',request),
  completeSale: async(request: CompleteSaleRequest) => {
    const result=await ipcRenderer.invoke('pos:complete-sale',request)
    window.postMessage({source:'raspechatka-pos',type:'sale-completed',result,payments:request.payments},'*')
    return result
  },
  getConnectionStatus: () => ipcRenderer.invoke('pos:get-connection-status'),
  saveConnection: (config:ConnectionConfig) => ipcRenderer.invoke('pos:save-connection',config),
  setActiveCashier: (cashierId:string) => ipcRenderer.invoke('pos:set-active-cashier',cashierId),
  syncNow: () => ipcRenderer.invoke('pos:sync-now')
}

contextBridge.exposeInMainWorld('raspechatkaPos', api)
