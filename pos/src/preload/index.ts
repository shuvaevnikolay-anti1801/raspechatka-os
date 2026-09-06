import { contextBridge, ipcRenderer } from 'electron'
import type { CompleteSaleRequest, ConnectionConfig, HeldReceipt, PosApi } from '../shared/contracts'

const api: PosApi = {
  getBootState: () => ipcRenderer.invoke('pos:get-boot-state'),
  listProducts: () => ipcRenderer.invoke('pos:list-products'),
  listCustomers: (query) => ipcRenderer.invoke('pos:list-customers',query),
  listSales: () => ipcRenderer.invoke('pos:list-sales'),
  listHeldReceipts: () => ipcRenderer.invoke('pos:list-held-receipts'),
  holdReceipt: (receipt:Omit<HeldReceipt,'id'|'createdAt'>) => ipcRenderer.invoke('pos:hold-receipt',receipt),
  deleteHeldReceipt: (id:string) => ipcRenderer.invoke('pos:delete-held-receipt',id),
  openShift: () => ipcRenderer.invoke('pos:open-shift'),
  closeShift: () => ipcRenderer.invoke('pos:close-shift'),
  getShiftSummary: () => ipcRenderer.invoke('pos:get-shift-summary'),
  completeSale: (request: CompleteSaleRequest) => ipcRenderer.invoke('pos:complete-sale', request),
  getConnectionStatus: () => ipcRenderer.invoke('pos:get-connection-status'),
  saveConnection: (config:ConnectionConfig) => ipcRenderer.invoke('pos:save-connection',config),
  syncNow: () => ipcRenderer.invoke('pos:sync-now')
}

contextBridge.exposeInMainWorld('raspechatkaPos', api)
