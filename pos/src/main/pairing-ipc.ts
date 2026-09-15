import { ipcMain } from 'electron'
import type { BootState } from '../shared/contracts'
import { ConnectionStore } from './connection'
import { PosDatabase } from './database'
import { PosDiagnostics } from './diagnostics'
import { buildBootState } from './sync'

export function registerPairingIpc(dependencies:{database:PosDatabase;connectionStore:ConnectionStore;diagnostics:PosDiagnostics}):void{
  const {database,connectionStore,diagnostics}=dependencies
  ipcMain.handle('pos:set-active-cashier',async(_event,cashierId:string):Promise<BootState>=>{
    const employees=database.listPointEmployees()
    const employee=employees.find((item)=>item.id===cashierId)
    if(!employee)throw new Error('Выберите сотрудника, прикреплённого к этой точке')
    if(database.currentShift())throw new Error('Нельзя менять кассира во время открытой смены')
    connectionStore.setCashier(cashierId)
    const current=buildBootState(database)
    database.setState('bootstrap',JSON.stringify({...current,cashierId:employee.id,cashierName:employee.name,accessRevoked:false}))
    diagnostics.record({source:'sync',eventType:'sync.cashier_selected',message:`Выбран кассир: ${employee.name}`})
    return buildBootState(database)
  })
}
