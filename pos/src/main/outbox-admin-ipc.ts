import { ipcMain } from 'electron'
import type { PosDatabase } from './database'
import type { PosDiagnostics } from './diagnostics'
import { verifyAdminCode } from './cashier-auth'

const assertAdmin=(code:string)=>{
  if(!verifyAdminCode(code))throw new Error('Неверный код администратора')
}

export function registerOutboxAdminIpc(dependencies:{database:PosDatabase;diagnostics:PosDiagnostics}):void {
  const {database,diagnostics}=dependencies

  ipcMain.handle('pos:list-outbox-events',()=>database.pendingEvents(1000))
  ipcMain.handle('pos:get-outbox-paused',()=>database.getState('outbox_paused')==='1')

  ipcMain.handle('pos:set-outbox-paused',(_event,paused:boolean,adminCode:string)=>{
    assertAdmin(adminCode)
    database.setState('outbox_paused',paused?'1':'0')
    diagnostics.record({
      source:'sync',
      level:paused?'warning':'info',
      eventType:paused?'sync.outbox_paused':'sync.outbox_resumed',
      message:paused?'Отправка очереди в Распечатка OS приостановлена администратором':'Отправка очереди в Распечатка OS возобновлена администратором'
    })
    return paused
  })

  ipcMain.handle('pos:discard-outbox-events',(_event,ids:string[],adminCode:string)=>{
    assertAdmin(adminCode)
    if(database.currentShift())throw new Error('Нельзя удалять события из очереди во время открытой смены')
    const requested=new Set((ids||[]).map((id)=>String(id||'').trim()).filter(Boolean))
    if(!requested.size)return {discarded:0,pending:database.pendingSyncCount()}
    const pending=database.pendingEvents(1000)
    const selected=pending.filter((event)=>requested.has(event.id))
    if(!selected.length)return {discarded:0,pending:database.pendingSyncCount()}

    // Marking as sent removes an event from the retry queue without deleting the
    // local business document. The diagnostic entry preserves the fact that the
    // server did not receive these events and they were intentionally discarded.
    database.markEventsSent(selected.map((event)=>event.id))
    diagnostics.record({
      source:'sync',
      level:'warning',
      eventType:'sync.outbox_discarded',
      message:`Администратор исключил из отправки ${selected.length} событий`,
      details:{events:selected.map((event)=>({id:event.id,eventType:event.eventType,createdAt:event.createdAt}))}
    })
    return {discarded:selected.length,pending:database.pendingSyncCount()}
  })
}
