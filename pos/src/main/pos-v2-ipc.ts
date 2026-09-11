import { ipcMain } from 'electron'
import type { ConnectionStore } from './connection'
import { searchPointReceipts } from './frappe'

export function registerPosV2Ipc(connectionStore:ConnectionStore):void{
  ipcMain.handle('pos:search-point-receipts',async(_event,query?:string)=>{
    const config=connectionStore.load()
    if(!config)throw new Error('Касса не подключена к Распечатка OS')
    return searchPointReceipts(config,query||'')
  })
}
