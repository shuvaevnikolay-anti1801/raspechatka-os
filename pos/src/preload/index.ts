import { contextBridge, ipcRenderer } from 'electron'
import type { CashOperationType, CompleteSaleRequest, ConnectionConfig, CreateReturnRequest, HeldReceipt, PosApi, PrintKind } from '../shared/contracts'

const api: PosApi = {
  getBootState: () => ipcRenderer.invoke('pos:get-boot-state'),
  listProducts: () => ipcRenderer.invoke('pos:list-products'),
  listCustomers: (query) => ipcRenderer.invoke('pos:list-customers',query),
  listSales: () => ipcRenderer.invoke('pos:list-sales'),
  getSale: (id:string) => ipcRenderer.invoke('pos:get-sale',id),
  createReturn: (request:CreateReturnRequest) => ipcRenderer.invoke('pos:create-return',request),
  listReturns: () => ipcRenderer.invoke('pos:list-returns'),
  printSale: (id:string,kind:PrintKind) => ipcRenderer.invoke('pos:print-sale',id,kind),
  listHeldReceipts: () => ipcRenderer.invoke('pos:list-held-receipts'),
  holdReceipt: (receipt:Omit<HeldReceipt,'id'|'createdAt'>) => ipcRenderer.invoke('pos:hold-receipt',receipt),
  deleteHeldReceipt: (id:string) => ipcRenderer.invoke('pos:delete-held-receipt',id),
  openShift: () => ipcRenderer.invoke('pos:open-shift'),
  closeShift: () => ipcRenderer.invoke('pos:close-shift'),
  getShiftSummary: () => ipcRenderer.invoke('pos:get-shift-summary'),
  listCashOperations: () => ipcRenderer.invoke('pos:list-cash-operations'),
  addCashOperation: (type:CashOperationType,amountMinor:number,reason:string) => ipcRenderer.invoke('pos:add-cash-operation',type,amountMinor,reason),
  completeSale: (request: CompleteSaleRequest) => ipcRenderer.invoke('pos:complete-sale', request),
  getConnectionStatus: () => ipcRenderer.invoke('pos:get-connection-status'),
  saveConnection: (config:ConnectionConfig) => ipcRenderer.invoke('pos:save-connection',config),
  syncNow: () => ipcRenderer.invoke('pos:sync-now')
}

contextBridge.exposeInMainWorld('raspechatkaPos', api)
