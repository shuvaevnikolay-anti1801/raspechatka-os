import { useEffect, useState } from 'react'
import type { BootState, ConnectionConfig, ConnectionStatus } from '../../shared/contracts'
import './pilot-ux.css'
import './settings-connection.css'

const blankConfig:ConnectionConfig={serverUrl:'https://os.rpechatka.ru',deviceId:'',token:''}

export default function SettingsModeGuard(){
  const [open,setOpen]=useState(false)
  const [connection,setConnection]=useState<ConnectionStatus|null>(null)
  const [boot,setBoot]=useState<BootState|null>(null)
  const [editing,setEditing]=useState(false)
  const [form,setForm]=useState<ConnectionConfig>(blankConfig)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')

  const refresh=async()=>{
    const [nextConnection,nextBoot]=await Promise.all([
      window.raspechatkaPos.getConnectionStatus(),window.raspechatkaPos.getBootState()
    ])
    setConnection(nextConnection);setBoot(nextBoot)
    setForm((current)=>({
      ...current,
      serverUrl:nextConnection.serverUrl||current.serverUrl,
      deviceId:nextConnection.deviceId||current.deviceId,
      token:''
    }))
    return {connection:nextConnection,boot:nextBoot}
  }

  useEffect(()=>{
    const handler=(event:MouseEvent)=>{
      const target=(event.target as HTMLElement|null)?.closest<HTMLButtonElement>('button')
      if(!target)return
      const navButtons=Array.from(document.querySelectorAll<HTMLButtonElement>('.main-nav>button'))
      const isSettings=navButtons[5]===target||Boolean(target.closest('.top-status'))
      if(!isSettings)return
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation()
      setOpen(true);setMessage('')
      void refresh().catch((error)=>setMessage(error instanceof Error?error.message:String(error)))
    }
    document.addEventListener('click',handler,true)
    return()=>document.removeEventListener('click',handler,true)
  },[])

  const reconnect=async()=>{
    setBusy(true);setMessage('Проверяем привязку кассы к точке…')
    try{
      await window.raspechatkaPos.saveConnection({...form,cashierId:undefined})
      const next=await window.raspechatkaPos.syncNow()
      setBoot(next);setEditing(false);setForm((current)=>({...current,token:''}))
      await refresh()
      setMessage(next.employees?.length>1&&!next.cashierId
        ?'Точка подключена. Выберите сотрудника этой точки.'
        :'Касса подключена к точке '+next.pointName)
    }catch(error){setMessage(error instanceof Error?error.message:String(error))}
    finally{setBusy(false)}
  }

  const selectCashier=async(cashierId:string)=>{
    setBusy(true);setMessage('Переключаем сотрудника…')
    try{
      const next=await window.raspechatkaPos.setActiveCashier(cashierId)
      setBoot(next);await refresh();setMessage('Сейчас работает: '+next.cashierName)
    }catch(error){setMessage(error instanceof Error?error.message:String(error))}
    finally{setBusy(false)}
  }

  if(!open)return null
  const connected=Boolean(connection?.configured&&boot?.source==='frappe')

  return <div className="pilot-backdrop">
    <section className="pilot-modal admin-gate">
      <header><div><small>НАСТРОЙКИ РАБОЧЕГО МЕСТА</small><h2>Касса Распечатка</h2></div><button onClick={()=>setOpen(false)}>×</button></header>

      {connected&&!editing?<>
        <div className="admin-gate-note">
          <b>Касса привязана к конкретной точке через Распечатка OS.</b>
          <span>Windows-приложение не выбирает точку самостоятельно — её определяет Device ID, созданный в OS.</span>
        </div>
        <dl className="connection-summary">
          <div><dt>Точка</dt><dd>{boot?.pointName}</dd></div>
          <div><dt>Рабочее место</dt><dd>{boot?.workstationName}</dd></div>
          <div><dt>Device ID</dt><dd>{connection?.deviceId}</dd></div>
          <div><dt>Сотрудник</dt><dd>{boot?.cashierName||'Не выбран'}</dd></div>
          <div><dt>OS</dt><dd>{boot?.online?'На связи':'Локальный режим'}</dd></div>
        </dl>
        {boot?.employees?.length?<div className="cashier-switch"><strong>Кто сейчас работает</strong><div>{boot.employees.map((employee)=><button key={employee.id} className={boot.cashierId===employee.id?'primary':''} disabled={busy} onClick={()=>void selectCashier(employee.id)}>{employee.name}</button>)}</div></div>:null}
        <p>АТОЛ, эквайринг и товарный принтер настраиваются через кнопку <b>«Оборудование»</b> в нижней панели состояния кассы.</p>
        {message&&<div className="settings-status">{message}</div>}
        <div className="readiness-actions"><button onClick={()=>setOpen(false)}>Закрыть</button><button onClick={()=>{setEditing(true);setMessage('')}}>Переподключить к OS</button></div>
      </>:<>
        <p>В Распечатка OS откройте <b>Продажи → Подключение кассы</b>, выберите нужную точку и возьмите выданные <b>Device ID</b> и <b>Token</b>.</p>
        <div className="pairing-fields">
          <label><span>Адрес Распечатка OS</span><input value={form.serverUrl} onChange={(e)=>setForm({...form,serverUrl:e.target.value})}/></label>
          <label><span>Device ID</span><input autoFocus value={form.deviceId} onChange={(e)=>setForm({...form,deviceId:e.target.value})} placeholder="POS-…" autoComplete="off"/></label>
          <label><span>Token</span><input type="password" value={form.token} onChange={(e)=>setForm({...form,token:e.target.value})} placeholder="Показывается в OS один раз" autoComplete="new-password"/></label>
        </div>
        <div className="admin-gate-note"><b>Token сохраняется только в защищённом хранилище Windows.</b><span>После сохранения приложение не показывает его обратно и не пишет в диагностический журнал.</span></div>
        {message&&<div className="settings-status">{message}</div>}
        <div className="readiness-actions"><button onClick={()=>connected?setEditing(false):setOpen(false)}>Отмена</button><button className="primary" disabled={busy||!form.deviceId.trim()||!form.token.trim()} onClick={()=>void reconnect()}>{busy?'Подключаем…':'Подключить кассу'}</button></div>
      </>}
    </section>
  </div>
}
