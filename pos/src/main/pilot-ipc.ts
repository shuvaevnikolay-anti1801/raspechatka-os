import { ipcMain } from 'electron'
import { PosDiagnostics } from './diagnostics'

export function registerPilotIpc(diagnostics:PosDiagnostics):void{
  ipcMain.handle('pos:record-shift-discrepancy',(_event,input:{differenceMinor:number;note:string})=>{
    const note=input.note?.trim()
    if(!note)throw new Error('Укажите причину расхождения наличных')
    const differenceMinor=Math.trunc(Number(input.differenceMinor)||0)
    return diagnostics.record({
      source:'shift',
      level:'warning',
      eventType:'shift.cash_discrepancy_confirmed',
      message:`Кассир подтвердил расхождение наличных ${differenceMinor/100} ₽: ${note}`,
      details:{differenceMinor,note}
    })
  })
}
