import { useEffect, useState } from 'react'
import type { BootState, ConnectionConfig, ConnectionStatus } from '../../shared/contracts'
import './device-pairing.css'

const defaultConfig:ConnectionConfig={serverUrl:'https://os.rpechatka.ru',deviceId:'',token:''}

export default function DevicePairingWizard(){
  const [connection,setConnection]=useState<ConnectionStatus|null>(null)
  const [boot,setBoot]=useState<BootState|null>(null)
  const [form,setForm]=useState<ConnectionConfig>(defaultConfig)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  const [dismissed,setDismissed]=useState(false)

  const refresh=async()=>{
    const [nextConnection,nextBoot]=await Promise.all([
      window.raspechatkaPos.getConnectionStatus(),window.raspechatkaPos.getBootState()
    ])
    setConnection(nextConnection);setBoot(nextBoot)
    setForm((current)=>({...current,serverUrl:nextConnection.serverUrl||current.serverUrl,deviceId:nextConnection.deviceId||current.deviceId}))
    return {connection:nextConnection,boot:nextBoot}
  }

  useEffect(()=>{void refresh().catch((error)=>setMessage(error instanceof Error?error.message:String(error)))},[])

  const pair=async()=>{
    setBusy(true);setMessage('Проверяем Device ID и Token в Распечатка OS…')
    try{
      await window.raspechatkaPos.saveConnection({...form,cashierId:undefined})
      let next=await window.raspechatkaPos.syncNow()
      setForm((current)=>({...current,token:''}))
      if(next.employees.length===1&&next.cashierId){
        next=await window.raspechatkaPos.setActiveCashier(next.cashierId)
      }
      await refresh();setBoot(next)
      setMessage(next.employees.length>1&&!next.cashierId?'Точка подключена. Теперь выберите сотрудника.':'Касса подключена к точке '+next.pointName)
    }catch(error){
      setMessage(error instanceof Error?error.message:String(error))
    }finally{setBusy(false)}
  }

  const selectCashier=async(cashierId:string)=>{
    if(!cashierId)return
    setBusy(true);setMessage('Подключаем сотрудника к текущей кассовой смене…')
    try{
      const next=await window.raspechatkaPos.setActiveCashier(cashierId)
      setBoot(next);await refresh();setMessage('Готово. Касса работает от имени '+next.cashierName)
    }catch(error){setMessage(error instanceof Error?error.message:String(error))}
    finally{setBusy(false)}
  }

  if(!connection||!boot)return null
  const needsPair=!connection.configured||boot.source!=='frappe'
  const needsCashier=connection.configured&&boot.source==='frappe'&&!connection.cashierId
  if((!needsPair&&!needsCashier)||dismissed)return null

  return <div className="pairing-backdrop">
    <section className="pairing-modal">
      <header><div className="pairing-logo">Р</div><div><small>ПЕРВЫЙ ЗАПУСК</small><h1>Подключение к Распечатка OS</h1></div></header>
      {needsPair?<>
        <p className="pairing-lead">Сначала в OS выберите конкретную точку: <b>Продажи → Подключение кассы</b>. Полученные там Device ID и Token вставьте сюда. Точку в Windows выбирать нельзя — она определяется самим Device ID.</p>
        <div className="pairing-fields">
          <label><span>Адрес Распечатка OS</span><input value={form.serverUrl} onChange={(e)=>setForm({...form,serverUrl:e.target.value})}/></label>
          <label><span>Device ID</span><input autoFocus value={form.deviceId} onChange={(e)=>setForm({...form,deviceId:e.target.value})} placeholder="POS-…" autoComplete="off"/></label>
          <label><span>Token</span><input type="password" value={form.token} onChange={(e)=>setForm({...form,token:e.target.value})} placeholder="Показывается в OS один раз" autoComplete="new-password"/></label>
        </div>
        <div className="pairing-security"><b>Token хранится только в защищённом хранилище Windows.</b><span>В журнал приложения он не записывается и после подключения не показывается.</span></div>
        {message&&<div className="pairing-message">{message}</div>}
        <button className="pairing-primary" disabled={busy||!form.deviceId.trim()||!form.token.trim()} onClick={()=>void pair()}>{busy?'Подключаем…':'Подключить кассу'}</button>
      </>:<>
        <div className="pairing-point"><small>КАССА ПРИВЯЗАНА К ТОЧКЕ</small><h2>{boot.pointName}</h2><span>{boot.workstationName}</span></div>
        {boot.employees.length?<>
          <p className="pairing-lead">Выберите, кто сейчас работает на кассе. Список получен только из сотрудников, прикреплённых к этой точке в OS.</p>
          <div className="pairing-employees">{boot.employees.map((employee)=><button key={employee.id} disabled={busy} onClick={()=>void selectCashier(employee.id)}><span>{employee.name}</span><b>Выбрать →</b></button>)}</div>
        </>:<div className="pairing-message error">В OS к этой точке не прикреплено ни одного активного сотрудника. Сначала добавьте сотрудника к точке.</div>}
        {message&&<div className="pairing-message">{message}</div>}
        <button className="pairing-secondary" onClick={()=>setDismissed(true)}>Закрыть пока без открытия смены</button>
      </>}
    </section>
  </div>
}
