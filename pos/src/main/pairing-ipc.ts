import { ipcMain } from 'electron'
import { PosDiagnostics } from './diagnostics'
import { CashierAuthSession, verifyAdminCode } from './cashier-auth'

export function registerPairingIpc(dependencies:{diagnostics:PosDiagnostics;cashierAuth:CashierAuthSession}):void{
  const {diagnostics,cashierAuth}=dependencies
  ipcMain.handle('pos:get-cashier-auth-state',()=>cashierAuth.state())
  ipcMain.handle('pos:begin-cashier-login',(_event,cashierId:string)=>cashierAuth.begin(cashierId))
  ipcMain.handle('pos:create-cashier-pin',(_event,cashierId:string,pin:string,confirmation:string)=>{
    const state=cashierAuth.createPin(cashierId,pin,confirmation)
    diagnostics.record({source:'app',eventType:'cashier.pin_created',message:'Кассир создал локальный PIN',details:{cashierId}})
    return state
  })
  ipcMain.handle('pos:login-cashier',(_event,cashierId:string,pin:string)=>cashierAuth.login(cashierId,pin))
  ipcMain.handle('pos:lock-cashier',()=>cashierAuth.lock())
  ipcMain.handle('pos:unlock-cashier',(_event,pin:string)=>cashierAuth.unlock(pin))
  ipcMain.handle('pos:logout-cashier',()=>cashierAuth.logout())
  ipcMain.handle('pos:verify-admin-code',(_event,code:string)=>verifyAdminCode(code))
  ipcMain.handle('pos:reset-cashier-pin',(_event,cashierId:string,adminCode:string,pin:string,confirmation:string)=>{
    cashierAuth.resetPin(cashierId,adminCode,pin,confirmation)
    diagnostics.record({source:'app',eventType:'cashier.pin_reset',message:'Администратор сбросил локальный PIN кассира',details:{cashierId}})
  })
}
