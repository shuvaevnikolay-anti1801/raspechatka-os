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

export class ShiftCoordinator {
  constructor(
    private readonly database:PosDatabase,
    private readonly fiscalProvider:FiscalProvider
  ){}

  async recoverPendingTransition():Promise<ShiftRecoveryResult>{
    const transition=this.loadTransition()
    if(!transition)return {recovered:false,pending:false}

    let fiscalShift:FiscalShiftStatus
    try{
      fiscalShift=await this.fiscalProvider.getShiftStatus()
    }catch(error){
      return {
        recovered:false,pending:true,
        message:`Не удалось проверить незавершённое действие со сменой ККТ: ${error instanceof Error?error.message:String(error)}`
      }
    }

    if(transition.action==='open'){
      if(!fiscalShift.open){
        this.clearTransition()
        return {recovered:false,pending:false,message:'Предыдущее открытие фискальной смены не завершилось. Можно безопасно повторить открытие.'}
      }
      if(fiscalShift.state==='expired'){
        return {recovered:false,pending:true,message:'Фискальная смена АТОЛ истекла во время открытия. Сначала её нужно закрыть; локальную смену автоматически не создаём.'}
      }
      const current=this.database.currentShift()
      if(!current){
        this.database.openShift({
          id:transition.shiftId,
          openedAt:transition.openedAt,
          cashierName:transition.cashierName
        })
      }
      this.clearTransition()
      return {recovered:true,pending:false,message:'Открытая на ККТ смена восстановлена после перезапуска кассы.'}
    }

    if(fiscalShift.open){
      this.clearTransition()
      return {recovered:false,pending:false,message:fiscalShift.state==='expired'
        ?'Фискальная смена истекла, но всё ещё открыта. Её можно безопасно закрыть повторной командой.'
        :'Предыдущее закрытие фискальной смены не произошло. Закрытие можно повторить.'}
    }

    const current=this.database.currentShift()
    if(current?.id===transition.shiftId)this.database.closeShift()
    this.clearTransition()
    return {recovered:true,pending:false,message:'Закрытие смены восстановлено после перезапуска кассы.'}
  }

  async openShift(cashierName:string):Promise<Shift>{
    const recovery=await this.recoverPendingTransition()
    if(recovery.pending)throw new Error(recovery.message||'Не удалось восстановить состояние фискальной смены')

    const current=this.database.currentShift()
    if(current){
      const fiscalShift=await this.fiscalProvider.getShiftStatus()
      if(!fiscalShift.open){
        throw new Error('Локальная смена открыта, но фискальная смена АТОЛ закрыта. Не открываем её автоматически: требуется проверить историю смены.')
      }
      if(fiscalShift.state==='expired'){
        throw new Error('Фискальная смена АТОЛ истекла. Новые продажи нельзя начинать: сначала закройте текущую смену и откройте новую.')
      }
      return current
    }

    const health=await this.fiscalProvider.healthCheck()
    if(!health.ready)throw new Error(`ККТ не готова: ${health.message}`)

    const shift:Shift={id:randomUUID(),openedAt:new Date().toISOString(),cashierName}
    const fiscalShift=await this.fiscalProvider.getShiftStatus()
    if(fiscalShift.state==='expired'){
      throw new Error('На АТОЛ осталась истёкшая фискальная смена. Сначала закройте её, затем откройте новую смену Распечатка Кассы.')
    }
    this.saveTransition({action:'open',shiftId:shift.id,openedAt:shift.openedAt,cashierName,startedAt:new Date().toISOString()})

    try{
      if(!fiscalShift.open)await this.fiscalProvider.openShift()
      const saved=this.database.openShift(shift)
      this.clearTransition()
      return saved
    }catch(error){
      try{
        const status=await this.fiscalProvider.getShiftStatus()
        if(status.open&&status.state!=='expired'){
          const saved=this.database.currentShift()??this.database.openShift(shift)
          this.clearTransition()
          return saved
        }
        if(!status.open)this.clearTransition()
      }catch{
        // Не очищаем transition: при следующем запуске сначала узнаем фактическое состояние ККТ.
      }
      throw error
    }
  }

  async closeShift(hasUnresolvedTransactions:boolean):Promise<ShiftSummary>{
    if(hasUnresolvedTransactions){
      throw new Error('Нельзя закрыть смену: есть незавершённые операции. Сначала завершите их в «Восстановлении».')
    }

    const recovery=await this.recoverPendingTransition()
    if(recovery.pending)throw new Error(recovery.message||'Не удалось восстановить состояние фискальной смены')

    const current=this.database.currentShift()
    if(!current)throw new Error('Нет открытой смены')

    const fiscalShift=await this.fiscalProvider.getShiftStatus()
    const health=await this.fiscalProvider.healthCheck()
    if(!health.ready&&fiscalShift.state!=='expired')throw new Error(`ККТ не готова к закрытию смены: ${health.message}`)

    this.saveTransition({action:'close',shiftId:current.id,startedAt:new Date().toISOString()})

    try{
      if(fiscalShift.open)await this.fiscalProvider.closeShift()
      const summary=this.database.closeShift()
      this.clearTransition()
      return summary
    }catch(error){
      try{
        const status=await this.fiscalProvider.getShiftStatus()
        if(!status.open){
          const summary=this.database.currentShift()?this.database.closeShift():this.database.getShiftSummary()
          this.clearTransition()
          return summary
        }
        this.clearTransition()
      }catch{
        // Оставляем transition. Повторное закрытие вслепую запрещено до проверки состояния ККТ.
      }
      throw error
    }
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
