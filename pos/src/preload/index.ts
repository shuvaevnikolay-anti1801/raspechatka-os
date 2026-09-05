import { contextBridge, ipcRenderer } from 'electron'
import type { CompleteSaleRequest, PosApi } from '../shared/contracts'

const api: PosApi = {
  getBootState: () => ipcRenderer.invoke('pos:get-boot-state'),
  listProducts: () => ipcRenderer.invoke('pos:list-products'),
  openShift: () => ipcRenderer.invoke('pos:open-shift'),
  completeSale: (request: CompleteSaleRequest) => ipcRenderer.invoke('pos:complete-sale', request)
}

contextBridge.exposeInMainWorld('raspechatkaPos', api)
