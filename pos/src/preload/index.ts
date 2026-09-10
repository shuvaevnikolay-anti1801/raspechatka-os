import { contextBridge, ipcRenderer } from 'electron'
import type { CashCount, CashCountLine, CashOperationType, CompleteSaleRequest, ConnectionConfig, CreateReturnRequest, CreateUnpaidOrderRequest, HeldReceipt, PosApi, PrintKind, StockWriteOffRequest, SupplyRequestInput, UpdateOrderRequest } from '../shared/contracts'

type AtolSettings={enabled:boolean;baseUrl:string;taxationType:string;taxType:string;operatorName?:string}
type ExtendedPosApi=PosApi&{
  getAtolSettings:()=>Promise<AtolSettings>
  saveAtolSettings:(value:AtolSettings)=>Promise<AtolSettings>
}

const api: ExtendedPosApi = {
  getBootState: () => ipcRenderer.invoke('pos:get-boot-state'),
  listProducts: () => ipcRenderer.invoke('pos:list-products'),
  listCustomers: (query) => ipcRenderer.invoke('pos:list-customers',query),
  listSales: () => ipcRenderer.invoke('pos:list-sales'),
  getSale: (id:string) => ipcRenderer.invoke('pos:get-sale',id),
  createReturn: (request:CreateReturnRequest) => ipcRenderer.invoke('pos:create-return',request),
  listReturns: () => ipcRenderer.invoke('pos:list-returns'),
  printSale: (id:string,kind:PrintKind) => ipcRenderer.invoke('pos:print-sale',id,kind),
  listPrinters: () => ipcRenderer.invoke('pos:list-printers'),
  getSelectedPrinter: () => ipcRenderer.invoke('pos:get-selected-printer'),
  setSelectedPrinter: (name:string) => ipcRenderer.invoke('pos:set-selected-printer',name),
  getDeviceStatuses: () => ipcRenderer.invoke('pos:get-device-statuses'),
  listUnresolvedOperations: () => ipcRenderer.invoke('pos:list-unresolved-operations'),
  recoverOperation: (id:string) => ipcRenderer.invoke('pos:recover-operation',id),
  getAtolSettings:()=>ipcRenderer.invoke('pos:get-atol-settings'),
  saveAtolSettings:(value:AtolSettings)=>ipcRenderer.invoke('pos:save-atol-settings',value),
  listHeldReceipts: () => ipcRenderer.invoke('pos:list-held-receipts'),
  holdReceipt: (receipt:Omit<HeldReceipt,'id'|'createdAt'>) => ipcRenderer.invoke('pos:hold-receipt',receipt),
  deleteHeldReceipt: (id:string) => ipcRenderer.invoke('pos:delete-held-receipt',id),
  openShift: () => ipcRenderer.invoke('pos:open-shift'),
  closeShift: () => ipcRenderer.invoke('pos:close-shift'),
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
  completeSale: (request: CompleteSaleRequest) => ipcRenderer.invoke('pos:complete-sale', request),
  getConnectionStatus: () => ipcRenderer.invoke('pos:get-connection-status'),
  saveConnection: (config:ConnectionConfig) => ipcRenderer.invoke('pos:save-connection',config),
  syncNow: () => ipcRenderer.invoke('pos:sync-now')
}

contextBridge.exposeInMainWorld('raspechatkaPos', api)
