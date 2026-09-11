import { randomUUID } from 'node:crypto'
import type { Shift, ShiftSummary } from '../shared/contracts'
import { PosDatabase } from './database'
import type { FiscalProvider, FiscalShiftStatus } from './providers/contracts'

const STATE_KEY='fiscal_shift_transition_v1'

type ShiftTransition =
  | {action:'open';shiftId:string;openedAt:string;cashierName:string;startedAt:string}
  | {action:'close';shiftId:string;startedAt:string}

export type ShiftRecoveryResult = {
  recovered:boolean
  pending:boolean
  message?:string
}

export type PendingShiftTransition = {
  action:'open'|'close'
  shiftId:string
  startedAt:string
}

export class ShiftCoordinator {
  constructor(
    private readonly database:PosDatabase,
    private readonly fiscalProvider:FiscalProvider
  ){}

  getPendingTransition():PendingShiftTransition|undefined{
    const transition=this.loadTransition()
    if(!transition)return undefined
    return {action:transition.action,shiftId:transition.shiftId,startedAt:transition.startedAt}
  }

  async recoverPendingTransition():Promise<ShiftRecoveryResult>{
    const transition=this.loadTransition()
    if(!transition)return {recovered:false,pending:false}

    let fiscalShift:FiscalShiftStatus
    try{
      fiscalShift=await this.fiscalProvider.getShiftStatus()
    }catch(error){
      return {
        recovered:false,pending:true,
        message:`Не удалось проверить отложенное действие со сменой ККТ: ${error instanceof Error?error.message:String(error)}`
      }
    }

    if(transition.action==='open'){
      // Рабочая смена сотрудника и фискальная смена ККТ — разные сущности.
      // Никогда не создаём рабочую смену только потому, что ККТ оказалась открыта.
      if(fiscalShift.open&&fiscalShift.state!=='expired'){
        this.clearTransition()
        return {recovered:true,pending:false,message:'Фискальная смена ККТ открыта.'}
      }

      const current=this.database.currentShift()
      if(!current||current.id!==transition.shiftId){
        // Рабочая смена уже закончилась: старое ожидание открытия ККТ больше
        // не должно само открывать сотруднику новую смену.
        this.clearTransition()
        return {recovered:false,pending:false,message:'Рабочая смена уже закрыта; отложенное открытие ККТ отменено.'}
      }
      if(fiscalShift.state==='expired'){
        return {recovered:false,pending:true,message:'На ККТ осталась истёкшая фискальная смена. Рабочая смена сотрудника открыта, но продажи заблокированы до обслуживания ККТ.'}
      }

      try{
        await this.fiscalProvider.openShift()
        this.clearTransition()
        return {recovered:true,pending:false,message:'Фискальная смена ККТ открыта после восстановления связи.'}
      }catch(error){
        return {recovered:false,pending:true,message:`Рабочая смена открыта, но ККТ пока недоступна: ${error instanceof Error?error.message:String(error)}`}
      }
    }

    // При закрытии рабочую смену сотрудника мы уже считаем завершённой.
    // Здесь восстанавливаем только фискальное закрытие, не меняя рабочую смену.
    if(!fiscalShift.open){
      this.clearTransition()
      return {recovered:true,pending:false,message:'Фискальная смена ККТ закрыта.'}
    }

    try{
      await this.fiscalProvider.closeShift()
      this.clearTransition()
      return {recovered:true,pending:false,message:'Отложенное закрытие фискальной смены ККТ завершено.'}
    }catch(error){
      return {recovered:false,pending:true,message:`Рабочая смена закрыта, но фискальную смену ККТ пока закрыть не удалось: ${error instanceof Error?error.message:String(error)}`}
    }
  }

  async openShift(cashierName:string):Promise<Shift>{
    const current=this.database.currentShift()
    if(current)return current

    // Сначала открываем именно рабочую смену сотрудника. Наличие ККТ не должно
    // мешать сотруднику начать рабочую смену; без готовой ККТ будут запрещены
    // только фискальные продажи и возвраты.
    const shift:Shift={id:randomUUID(),openedAt:new Date().toISOString(),cashierName}
    const saved=this.database.openShift(shift)
    this.saveTransition({action:'open',shiftId:shift.id,openedAt:shift.openedAt,cashierName,startedAt:new Date().toISOString()})

    // Фискальную смену пытаемся привести в нужное состояние best effort.
    // Ошибка ККТ не откатывает уже открытую рабочую смену сотрудника.
    try{
      await this.recoverPendingTransition()
    }catch{
      // Маркер transition остаётся и будет восстановлен при следующей проверке.
    }
    return saved
  }

  async closeShift(hasUnresolvedTransactions:boolean):Promise<ShiftSummary>{
    const current=this.database.currentShift()
    if(!current)throw new Error('Нет открытой рабочей смены')

    // Рабочая смена должна закрываться всегда — даже если ККТ, эквайринг или
    // сеть недоступны. Незавершённые транзакции остаются в механизме recovery
    // и не удерживают сотрудника в открытой рабочей смене.
    const summary=this.database.closeShift()
    this.saveTransition({action:'close',shiftId:current.id,startedAt:new Date().toISOString()})

    try{
      const recovery=await this.recoverPendingTransition()
      if(recovery.pending){
        return {
          ...summary,
          fiscalClosePending:true,
          warning:recovery.message||(hasUnresolvedTransactions
            ?'Рабочая смена закрыта. Есть незавершённые операции и отложенное закрытие ККТ.'
            :'Рабочая смена закрыта. Закрытие ККТ будет завершено после восстановления связи.')
        }
      }
    }catch(error){
      return {
        ...summary,
        fiscalClosePending:true,
        warning:`Рабочая смена закрыта. ККТ требует последующего закрытия: ${error instanceof Error?error.message:String(error)}`
      }
    }

    if(hasUnresolvedTransactions){
      return {...summary,warning:'Рабочая смена закрыта. Незавершённые операции сохранены для последующего восстановления.'}
    }
    return summary
  }

  private loadTransition():ShiftTransition|undefined{
    const raw=this.database.getState(STATE_KEY)
    if(!raw)return undefined
    try{return JSON.parse(raw) as ShiftTransition}catch{this.clearTransition();return undefined}
  }

  private saveTransition(transition:ShiftTransition):void{
    this.database.setState(STATE_KEY,JSON.stringify(transition))
  }

  private clearTransition():void{
    this.database.setState(STATE_KEY,'')
  }
}
