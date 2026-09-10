import { useEffect, useState } from 'react'
import type { DeviceStatuses, PrinterInfo, UnresolvedOperation } from '../../shared/contracts'
import './safety.css'

type AtolSettings={enabled:boolean;baseUrl:string;taxationType:string;taxType:string;operatorName?:string}
type ExtendedPosApi=typeof window.raspechatkaPos&{
  getAtolSettings:()=>Promise<AtolSettings>
  saveAtolSettings:(value:AtolSettings)=>Promise<AtolSettings>
}
const pos=()=>window.raspechatkaPos as ExtendedPosApi

const money=(minor:number)=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(minor/100)
const stateNames:Record<UnresolvedOperation['state'],string>={
  created:'Создана',payment_in_progress:'Оплата выполняется',payment_confirmed:'Оплата подтверждена',payment_unknown:'Статус оплаты неизвестен',
  fiscalization_in_progress:'Чек формируется',fiscalized:'Фискализировано',fiscal_status_unknown:'Статус ККТ неизвестен',completed:'Завершено',requires_attention:'Требует внимания'
}
const defaultAtol:AtolSettings={enabled:false,baseUrl:'http://127.0.0.1:16732/api/v2',taxationType:'patent',taxType:'none',operatorName:''}

export default function PosSafetyPanel(){
  const [devices,setDevices]=useState<DeviceStatuses|null>(null)
  const [unresolved,setUnresolved]=useState<UnresolvedOperation[]>([])
  const [printers,setPrinters]=useState<PrinterInfo[]>([])
  const [selectedPrinter,setSelectedPrinter]=useState('')
  const [atol,setAtol]=useState<AtolSettings>(defaultAtol)
  const [open,setOpen]=useState(false)
  const [message,setMessage]=useState('')

  const refresh=async()=>{
    const [nextDevices,nextOperations,nextPrinters,nextSelected,nextAtol]=await Promise.all([
      pos().getDeviceStatuses(),pos().listUnresolvedOperations(),
      pos().listPrinters(),pos().getSelectedPrinter(),pos().getAtolSettings()
    ])
    setDevices(nextDevices);setUnresolved(nextOperations);setPrinters(nextPrinters);setSelectedPrinter(nextSelected||'');setAtol(nextAtol)
  }

  useEffect(()=>{
    refresh().catch(()=>undefined)
    const timer=window.setInterval(()=>refresh().catch(()=>undefined),10000)
    return()=>window.clearInterval(timer)
  },[])

  const selectPrinter=async(name:string)=>{
    try{await pos().setSelectedPrinter(name);setSelectedPrinter(name);setMessage('Товарный принтер сохранён');await refresh()}
    catch(error){setMessage(error instanceof Error?error.message:String(error))}
  }

  const saveAtol=async()=>{
    try{
      const saved=await pos().saveAtolSettings(atol)
      setAtol(saved);setMessage('Настройки АТОЛ сохранены. Проверяем связь с ККТ…')
      await refresh()
    }catch(error){setMessage(error instanceof Error?error.message:String(error))}
  }

  const recover=async(id:string)=>{
    try{
      setMessage('Проверяем фактическое состояние операции…')
      const result=await pos().recoverOperation(id)
      setMessage(result.message);await refresh()
    }catch(error){setMessage(error instanceof Error?error.message:String(error));await refresh()}
  }

  const statusClass=(ready:boolean,status?:string)=>ready?'ok':status==='not_configured'?'muted':'bad'
  return <>
    <aside className="safety-strip" aria-label="Состояние кассы">
      <Status label="ККТ" value={devices?.fiscal.message||'Проверяем…'} state={statusClass(Boolean(devices?.fiscal.ready),devices?.fiscal.status)}/>
      <Status label="Терминал" value={devices?.payment.message||'Проверяем…'} state={statusClass(Boolean(devices?.payment.ready),devices?.payment.status)}/>
      <Status label="Товарный принтер" value={devices?.printer.message||'Проверяем…'} state={statusClass(Boolean(devices?.printer.ready),devices?.printer.status)}/>
      <button className={unresolved.length?'recovery-button danger':'recovery-button'} onClick={()=>setOpen(true)}>
        {unresolved.length?`Восстановление · ${unresolved.length}`:'Оборудование'}
      </button>
    </aside>
    {open&&<div className="safety-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget)setOpen(false)}}>
      <section className="safety-panel">
        <header><div><small>НАДЁЖНОСТЬ КАССЫ</small><h2>Оборудование и восстановление</h2></div><button onClick={()=>setOpen(false)}>×</button></header>
        <div className="device-cards">
          <DeviceCard title="ККТ АТОЛ" status={devices?.fiscal}/>
          <DeviceCard title="Эквайринг" status={devices?.payment}/>
          <DeviceCard title="Товарный принтер" status={devices?.printer}/>
        </div>
        <section className="hardware-settings atol-settings">
          <div className="settings-title"><div><h3>АТОЛ 1Ф · USB</h3><p>Приложение работает через локальный Web Server Драйвера ККТ 10. Включите его после того, как АТОЛ виден в утилите драйвера.</p></div><label className="toggle"><input type="checkbox" checked={atol.enabled} onChange={(event)=>setAtol({...atol,enabled:event.target.checked})}/><span>Использовать АТОЛ</span></label></div>
          <div className="settings-grid">
            <label><span>Адрес Web Server</span><input value={atol.baseUrl} onChange={(event)=>setAtol({...atol,baseUrl:event.target.value})}/></label>
            <label><span>Система налогообложения</span><select value={atol.taxationType} onChange={(event)=>setAtol({...atol,taxationType:event.target.value})}><option value="patent">Патент</option><option value="usnIncome">УСН доход</option><option value="usnIncomeOutcome">УСН доход − расход</option><option value="osn">ОСН</option></select></label>
            <label><span>НДС позиции</span><select value={atol.taxType} onChange={(event)=>setAtol({...atol,taxType:event.target.value})}><option value="none">Без НДС</option><option value="vat0">НДС 0%</option><option value="vat5">НДС 5%</option><option value="vat7">НДС 7%</option><option value="vat10">НДС 10%</option><option value="vat20">НДС 20%</option><option value="vat22">НДС 22%</option></select></label>
            <label><span>Кассир для ККТ (если требуется)</span><input value={atol.operatorName||''} onChange={(event)=>setAtol({...atol,operatorName:event.target.value})} placeholder="Можно оставить пустым"/></label>
          </div>
          <button className="save-hardware" onClick={saveAtol}>Сохранить и проверить АТОЛ</button>
        </section>
        <section className="printer-settings">
          <div><h3>Принтер товарного чека</h3><p>Выберите установленный в Windows принтер один раз. Дальше печать идёт на него без системного окна.</p></div>
          <select value={selectedPrinter} onChange={(event)=>selectPrinter(event.target.value)}>
            <option value="">Не выбран</option>
            {printers.map((printer)=><option key={printer.name} value={printer.name}>{printer.name}{printer.isDefault?' · по умолчанию':''}</option>)}
          </select>
        </section>
        <section className="recovery-list">
          <h3>Незавершённые операции</h3>
          {!unresolved.length?<div className="recovery-empty"><strong>Всё в порядке</strong><span>Нет операций с неизвестным состоянием оплаты или ККТ.</span></div>:
          unresolved.map((operation)=><article key={operation.id} className={operation.state.includes('unknown')?'critical':''}>
            <div><b>{operation.kind==='sale'?'Продажа':'Возврат'} · {money(operation.amountMinor)}</b><small>{new Date(operation.createdAt).toLocaleString('ru-RU')}</small></div>
            <div><strong>{stateNames[operation.state]}</strong>{operation.lastError&&<small>{operation.lastError}</small>}</div>
            <button onClick={()=>recover(operation.id)}>Проверить и продолжить</button>
          </article>)}
        </section>
        {message&&<div className="safety-message">{message}</div>}
        <footer><button onClick={()=>refresh().catch((error)=>setMessage(String(error)))}>Обновить состояние</button><button onClick={()=>setOpen(false)}>Закрыть</button></footer>
      </section>
    </div>}
  </>
}

function Status({label,value,state}:{label:string;value:string;state:'ok'|'bad'|'muted'}){
  return <div className={'safety-status '+state} title={value}><i/><span>{label}</span><small>{value}</small></div>
}

function DeviceCard({title,status}:{title:string;status:DeviceStatuses['fiscal']|undefined}){
  return <article className={status?.ready?'ready':'not-ready'}><small>{title}</small><strong>{status?.ready?'Готово':status?.status==='not_configured'?'Не настроено':'Проблема'}</strong><span>{status?.message||'Проверяем…'}</span></article>
}
