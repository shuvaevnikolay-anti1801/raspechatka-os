import { ipcMain } from 'electron'
import type { ConnectionStore } from './connection'
import { searchPointReceipts } from './frappe'

type ReceiptSearchFilters={
  period?:'current_shift'|'today'|'yesterday'|'7d'|'30d'|'custom'|'all'
  shiftExternalId?:string
  dateFrom?:string
  dateTo?:string
  cashierId?:string
  amountMinMinor?:number
  amountMaxMinor?:number
  paymentChannel?:'Cash'|'Card'|'QR'|''
  status?:'Draft'|'Posted'|'Cancelled'|''
  receiptType?:'Sale'|'Return'|''
}

export function registerPosV2Ipc(connectionStore:ConnectionStore):void{
  ipcMain.handle('pos:search-point-receipts',async(_event,query?:string,filters?:ReceiptSearchFilters)=>{
    const config=connectionStore.load()
    if(!config)throw new Error('Касса не подключена к Распечатка OS')
    return searchPointReceipts(config,query||'',filters||{})
  })
}
