import { useEffect, useState } from 'react'
import './shift-recovery.css'

type ShiftRecoveryStatus={
  pending:boolean
  action?:'open'|'close'
  startedAt?:string
  localOpen:boolean
  fiscalOpen?:boolean
  fiscalState?:'closed'|'opened'|'expired'|'unknown'
  safeToRecover:boolean
  message:string
}
type ExtendedPosApi=typeof window.raspechatkaPos&{
  getShiftRecoveryStatus:()=>Promise<ShiftRecoveryStatus>
  recoverShiftState:()=>Promise<{recovered:boolean;pending:boolean;message?:string}>
}
const pos=()=>window.raspechatkaPos as ExtendedPosApi

export default function ShiftRecoveryBanner(){
  const [status,setStatus]=useState<ShiftRecoveryStatus|null>(null)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')

  const refresh=async()=>setStatus(await pos().getShiftRecoveryStatus())
  useEffect(()=>{
    void refresh().catch(()=>undefined)
    const timer=window.setInterval(()=>void refresh().catch(()=>undefined),5000)
    return()=>window.clearInterval(timer)
  },[])

  if(!status)return null
  const mismatch=status.fiscalOpen!==undefined&&status.localOpen!==status.fiscalOpen
  const attention=status.pending||mismatch||status.fiscalState==='expired'||status.fiscalState==='unknown'
  if(!attention)return null

  const recover=async()=>{
    setBusy(true);setMessage('Проверяем фактическое состояние АТОЛ…')
    try{
      const result=await pos().recoverShiftState()
      setMessage(result.message||'Проверка завершена')
      await refresh()
    }catch(error){
      setMessage(error instanceof Error?error.message:String(error))
    }finally{setBusy(false)}
  }

  return <aside className="shift-recovery-banner" role="alert">
    <div className="shift-recovery-icon">!</div>
    <div className="shift-recovery-copy">
      <strong>{status.pending?'Незавершённая операция со сменой':'Состояние смены требует проверки'}</strong>
      <span>{status.message}</span>
      {message&&<small>{message}</small>}
    </div>
    {status.safeToRecover&&<button disabled={busy} onClick={recover}>{busy?'Проверяем…':'Проверить и восстановить'}</button>}
    {!status.safeToRecover&&<div className="shift-recovery-lock">Продажи заблокированы до устранения причины</div>}
  </aside>
}
