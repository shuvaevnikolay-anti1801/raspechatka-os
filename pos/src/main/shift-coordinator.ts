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

    // Рабочая смена сотрудника уже закрыта. Восстанавливаем только фискальное
    // закрытие ККТ и никогда не создаём/закрываем рабочую смену из состояния ККТ.
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

    // Рабочая смена открывается явно сотрудником и не зависит от доступности
    // ККТ. Если ККТ недоступна, продажи будут заблокированы отдельной проверкой.
    const shift:Shift={id:randomUUID(),openedAt:new Date().toISOString(),cashierName}
    const saved=this.database.openShift(shift)
    this.saveTransition({action:'open',shiftId:shift.id,openedAt:shift.openedAt,cashierName,startedAt:new Date().toISOString()})

    try{
      await this.recoverPendingTransition()
    }catch{
      // Рабочая смена уже открыта. Маркер ККТ остаётся для последующего recovery.
    }
    return saved
  }

  async closeShift(hasUnresolvedTransactions:boolean):Promise<ShiftSummary>{
    const current=this.database.currentShift()
    if(!current)throw new Error('Нет открытой рабочей смены')

    // Рабочая смена сотрудника закрывается независимо от состояния ККТ,
    // эквайринга и recovery-операций. Это не означает, что фискальная смена
    // закрыта: для неё сохраняется отдельный pending transition.
    const summary=this.database.closeShift()
    this.saveTransition({action:'close',shiftId:current.id,startedAt:new Date().toISOString()})

    try{
      await this.recoverPendingTransition()
    }catch{
      // Не откатываем закрытие рабочей смены. Фискальное закрытие будет
      // повторено после восстановления связи с ККТ.
    }

    void hasUnresolvedTransactions
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
