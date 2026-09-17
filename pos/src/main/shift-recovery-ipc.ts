import { ipcMain } from 'electron'
import { PosDiagnostics } from './diagnostics'
import { PosDatabase } from './database'
import type { FiscalProvider } from './providers/contracts'
import { ShiftCoordinator } from './shift-coordinator'

export type ShiftRecoveryStatus={
  pending:boolean
  action?:'open'|'close'
  startedAt?:string
  localOpen:boolean
  fiscalOpen?:boolean
  fiscalState?:'closed'|'opened'|'expired'|'unknown'
  safeToRecover:boolean
  message:string
}

const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error)

export function registerShiftRecoveryIpc(dependencies:{
  database:PosDatabase
  fiscalProvider:FiscalProvider
  shiftCoordinator:ShiftCoordinator
  diagnostics:PosDiagnostics
}):void{
  const {database,fiscalProvider,shiftCoordinator,diagnostics}=dependencies

  ipcMain.handle('pos:get-shift-recovery-status',async():Promise<ShiftRecoveryStatus>=>{
    const pending=shiftCoordinator.getPendingTransition()
    const localOpen=Boolean(database.currentShift())
    try{
      const fiscal=await fiscalProvider.getShiftStatus()
      const mismatch=localOpen!==fiscal.open
      return {
        pending:Boolean(pending),
        action:pending?.action,
        startedAt:pending?.startedAt,
        localOpen,
        fiscalOpen:fiscal.open,
        fiscalState:fiscal.state,
        safeToRecover:Boolean(pending),
        message:pending
          ?`Есть незавершённое ${pending.action==='open'?'открытие':'закрытие'} смены. Касса может сначала сверить фактическое состояние АТОЛ.`
          :fiscal.state==='expired'
            ?'Фискальная смена АТОЛ истекла. Продажи должны оставаться заблокированы до корректного закрытия.'
            :mismatch
              ?`Состояние смен не совпадает: локальная ${localOpen?'открыта':'закрыта'}, АТОЛ ${fiscal.open?'открыта':'закрыта'}. Автоматически исправлять без незавершённого перехода небезопасно.`
              :'Незавершённых действий со сменой нет.'
      }
    }catch(error){
      return {
        pending:Boolean(pending),
        action:pending?.action,
        startedAt:pending?.startedAt,
        localOpen,
        fiscalState:'unknown',
        safeToRecover:Boolean(pending),
        message:`Не удалось проверить состояние смены АТОЛ: ${errorMessage(error)}`
      }
    }
  })

  ipcMain.handle('pos:recover-shift-state',async()=>{
    const pending=shiftCoordinator.getPendingTransition()
    diagnostics.record({
      source:'recovery',
      level:'warning',
      eventType:'shift.manual_recovery_started',
      message:pending
        ?`Проверяем незавершённое ${pending.action==='open'?'открытие':'закрытие'} смены`
        :'Запрошена проверка состояния смены без незавершённого перехода'
    })
    const result=await shiftCoordinator.recoverPendingTransition()
    diagnostics.record({
      source:'recovery',
      level:result.pending?'warning':'info',
      eventType:'shift.manual_recovery_result',
      message:result.message||'Проверка состояния смены завершена'
    })
    return result
  })
}
