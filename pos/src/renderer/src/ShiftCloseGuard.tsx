import { useEffect, useRef, useState } from 'react'
import './pilot-ux.css'

type ExtendedPosApi=typeof window.raspechatkaPos&{
  recordShiftDiscrepancy:(differenceMinor:number,note:string)=>Promise<unknown>
}
const parseMoney=(text:string)=>{
  const normalized=text.replace(/\s/g,'').replace(/[^\d,.-]/g,'').replace(',','.')
  return Math.round((Number(normalized)||0)*100)
}

export default function ShiftCloseGuard(){
  const [open,setOpen]=useState(false)
  const [differenceMinor,setDifferenceMinor]=useState(0)
  const [note,setNote]=useState('')
  const [error,setError]=useState('')
  const target=useRef<HTMLButtonElement|null>(null)
  const allowNext=useRef(false)

  useEffect(()=>{
    const handler=(event:MouseEvent)=>{
      const button=(event.target as HTMLElement|null)?.closest<HTMLButtonElement>('button')
      if(!button||!button.closest('.cash-count-modal')||!button.textContent?.toLocaleLowerCase('ru').includes('закрыть смену'))return
      if(allowNext.current){allowNext.current=false;return}
      const mismatch=button.closest('.cash-count-modal')?.querySelector<HTMLElement>('.cash-reconcile .mismatch strong')
      if(!mismatch)return
      const difference=parseMoney(mismatch.textContent||'')
      if(difference===0)return
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation()
      target.current=button;setDifferenceMinor(difference);setNote('');setError('');setOpen(true)
    }
    document.addEventListener('click',handler,true)
    return()=>document.removeEventListener('click',handler,true)
  },[])

  const confirm=async()=>{
    if(!note.trim())return
    try{
      await (window.raspechatkaPos as ExtendedPosApi).recordShiftDiscrepancy(differenceMinor,note.trim())
      setOpen(false);allowNext.current=true
      window.setTimeout(()=>target.current?.click(),0)
    }catch(e){setError(e instanceof Error?e.message:String(e))}
  }

  if(!open)return null
  return <div className="pilot-backdrop">
    <section className="pilot-modal discrepancy-modal">
      <header><div><small>ЗАКРЫТИЕ СМЕНЫ</small><h2>Есть расхождение наличных</h2></div><button onClick={()=>setOpen(false)}>×</button></header>
      <div className="discrepancy-amount"><span>Расхождение</span><strong>{new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(differenceMinor/100)}</strong></div>
      <p>Смена может быть закрыта, но причина должна остаться в журнале кассы. Напишите коротко, что произошло.</p>
      <label className="discrepancy-note"><span>Комментарий *</span><textarea autoFocus value={note} onChange={(e)=>setNote(e.target.value)} placeholder="Например: при пересчёте не хватает 100 ₽, сообщено старшему менеджеру"/></label>
      {error&&<div className="pilot-message error">{error}</div>}
      <div className="readiness-actions"><button onClick={()=>setOpen(false)}>Вернуться к пересчёту</button><button className="primary" disabled={!note.trim()} onClick={()=>void confirm()}>Записать причину и закрыть смену</button></div>
    </section>
  </div>
}
