import { ipcMain } from 'electron'
import type { ReceiptSearchFilters } from '../shared/contracts'
import type { ConnectionStore } from './connection'
import { getPointReceipt, searchPointReceipts } from './frappe'

export function registerPosV2Ipc(connectionStore:ConnectionStore):void{
  ipcMain.handle('pos:search-point-receipts',async(_event,query?:string,filters?:ReceiptSearchFilters)=>{
    const config=connectionStore.load()
    if(!config)throw new Error('Касса не подключена к Распечатка OS')
    return searchPointReceipts(config,query||'',filters||{})
  })
  ipcMain.handle('pos:get-point-receipt',async(_event,id:string)=>{
    const config=connectionStore.load()
    if(!config)throw new Error('Касса не подключена к Распечатка OS')
    return getPointReceipt(config,id)
  })
}
