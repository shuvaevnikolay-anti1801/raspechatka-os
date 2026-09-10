import { ipcMain } from 'electron'
import type { AtolSettingsStore } from './providers/atol-web'

export function registerHardwareSettingsIpc(atolSettingsStore:AtolSettingsStore):void{
  ipcMain.handle('pos:get-atol-settings',()=>atolSettingsStore.load())
  ipcMain.handle('pos:save-atol-settings',(_event,value:{enabled:boolean;baseUrl:string;taxationType:string;taxType:string;operatorName?:string})=>
    atolSettingsStore.save(value))
}
