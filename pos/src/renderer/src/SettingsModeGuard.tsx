import { useEffect, useRef, useState } from 'react'
import './pilot-ux.css'

export default function SettingsModeGuard(){
  const [open,setOpen]=useState(false)
  const unlocked=useRef(false)
  const pendingTarget=useRef<HTMLButtonElement|null>(null)

  useEffect(()=>{
    const handler=(event:MouseEvent)=>{
      if(unlocked.current)return
      const target=(event.target as HTMLElement|null)?.closest<HTMLButtonElement>('button')
      if(!target)return
      const navButtons=Array.from(document.querySelectorAll<HTMLButtonElement>('.main-nav>button'))
      const isSettings=navButtons[5]===target||Boolean(target.closest('.top-status'))
      if(!isSettings)return
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation()
      pendingTarget.current=navButtons[5]||target
      setOpen(true)
    }
    document.addEventListener('click',handler,true)
    return()=>document.removeEventListener('click',handler,true)
  },[])

  const continueToSettings=()=>{
    unlocked.current=true
    setOpen(false)
    window.setTimeout(()=>pendingTarget.current?.click(),0)
  }

  if(!open)return null
  return <div className="pilot-backdrop">
    <section className="pilot-modal admin-gate">
      <header><div><small>ТЕХНИЧЕСКИЙ РАЗДЕЛ</small><h2>Настройки рабочего места</h2></div><button onClick={()=>setOpen(false)}>×</button></header>
      <p>Здесь находятся подключение кассы к конкретной точке, АТОЛ, принтер и эквайринг. В обычной работе кассиру этот раздел не нужен.</p>
      <div className="admin-gate-note"><b>Device ID определяет точку, а Token хранится в защищённом хранилище Windows.</b><span>Позже доступ к техническим настройкам будет определяться ролью сотрудника из Распечатка OS.</span></div>
      <div className="readiness-actions"><button onClick={()=>setOpen(false)}>Отмена</button><button className="primary" onClick={continueToSettings}>Открыть технические настройки</button></div>
    </section>
  </div>
}
