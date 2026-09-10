import { useEffect, useState } from 'react'
import type { DeviceStatuses, PrintJobSummary, PrinterInfo, UnresolvedOperation } from '../../shared/contracts'
import './safety.css'

type AtolSettings={enabled:boolean;baseUrl:string;taxationType:string;taxType:string;operatorName?:string}
type ExtendedPosApi=typeof window.raspechatkaPos&{
  getAtolSettings:()=>Promise<AtolSettings>
  saveAtolSettings:(value:AtolSettings)=>Promise<AtolSettings>
}
const pos=()=>window.raspechatkaPos as ExtendedPosApi

const money=(minor:number)=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(minor/100)
const defaultAtol:AtolSettings={enabled:false,baseUrl:'http://127.0.0.1:16732/api/v2',taxationType:'patent',taxType:'none',operatorName:''}

const recoveryText=(operation:UnresolvedOperation):{title:string;detail:string;critical:boolean}=>{
  if(operation.state==='payment_unknown'||operation.state==='payment_in_progress')return {
    title:`Результат оплаты ${money(operation.amountMinor)} неизвестен`,
    detail:'Не повторяйте оплату. Касса сначала проверит исходную операцию терминала.',critical:true
  }
  if(operation.state==='payment_confirmed')return {
    title:`Оплата ${money(operation.amountMinor)} получена`,
    detail:'Деньги подтверждены. Нужно безопасно продолжить формирование фискального чека.',critical:true
  }
  if(operation.state==='fiscal_status_unknown'||operation.state==='fiscalization_in_progress')return {
    title:'Состояние фискального чека неизвестно',
    detail:'Не пробивайте второй чек вручную. Касса сначала запросит результат уже начатой операции АТОЛ.',critical:true
  }
  if(operation.state==='fiscalized')return {
    title:'Фискальный чек уже пробит',
    detail:'Повторная фискализация запрещена. Нужно только завершить локальную запись операции.',critical:false
  }
  return {
    title:operation.kind==='sale'?'Продажу нужно завершить':'Возврат нужно завершить',
    detail:operation.lastError||'Операция сохранена локально и может быть безопасно продолжена.',critical:false
  }
}

export default function PosSafetyPanel(){
  const [devices,setDevices]=useState<DeviceStatuses|null>(null)
  const [unresolved,setUnresolved]=useState<UnresolvedOperation[]>([])
  const [printJobs,setPrintJobs]=useState<PrintJobSummary[]>([])
  const [printers,setPrinters]=useState<PrinterInfo[]>([])
  const [selectedPrinter,setSelectedPrinter]=useState('')
  const [atol,setAtol]=useState<AtolSettings>(defaultAtol)
  const [open,setOpen]=useState(false)
  const [message,setMessage]=useState('')

  const refresh=async()=>{
    const [nextDevices,nextOperations,nextPrintJobs,nextPrinters,nextSelected,nextAtol]=await Promise.all([
      pos().getDeviceStatuses(),pos().listUnresolvedOperations(),pos().listPrintJobs(),
      pos().listPrinters(),pos().getSelectedPrinter(),pos().getAtolSettings()
    ])
    setDevices(nextDevices);setUnresolved(nextOperations);setPrintJobs(nextPrintJobs)
    setPrinters(nextPrinters);setSelectedPrinter(nextSelected||'');setAtol(nextAtol)
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

  const retryPrint=async(id:string)=>{
    try{
      const result=await pos().retryPrintJob(id)
      setMessage(result.message);await refresh()
    }catch(error){setMessage(error instanceof Error?error.message:String(error));await refresh()}
  }

  const statusClass=(ready:boolean,status?:string)=>ready?'ok':status==='not_configured'?'muted':'bad'
  const attentionCount=unresolved.length+printJobs.length
  return <>
    <aside className="safety-strip" aria-label="Состояние кассы">
      <Status label="OS" value={devices?.os.message||'Проверяем…'} state={statusClass(Boolean(devices?.os.ready),devices?.os.status)}/>
      <Status label="ККТ" value={devices?.fiscal.message||'Проверяем…'} state={statusClass(Boolean(devices?.fiscal.ready),devices?.fiscal.status)}/>
      <Status label="Терминал" value={devices?.payment.message||'Проверяем…'} state={statusClass(Boolean(devices?.payment.ready),devices?.payment.status)}/>
      <Status label="Принтер" value={devices?.printer.message||'Проверяем…'} state={statusClass(Boolean(devices?.printer.ready),devices?.printer.status)}/>
      <Status label="Смена" value={devices?.shift.message||'Проверяем…'} state={devices?.shift.ready?'ok':'bad'}/>
      <button className={attentionCount?'recovery-button danger':'recovery-button'} onClick={()=>setOpen(true)}>
        {attentionCount?`Требует внимания · ${attentionCount}`:'Оборудование'}
      </button>
    </aside>
    {open&&<div className="safety-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget)setOpen(false)}}>
      <section className="safety-panel">
        <header><div><small>НАДЁЖНОСТЬ КАССЫ</small><h2>Оборудование и восстановление</h2></div><button onClick={()=>setOpen(false)}>×</button></header>
        <div className="device-cards">
          <DeviceCard title="Raspechatka OS" status={devices?.os}/>
          <DeviceCard title="ККТ АТОЛ" status={devices?.fiscal}/>
          <DeviceCard title="Эквайринг" status={devices?.payment}/>
          <DeviceCard title="Товарный принтер" status={devices?.printer}/>
        </div>
        <section className={devices?.shift.ready?'shift-safety ready':'shift-safety danger'}>
          <div><small>СОСТОЯНИЕ СМЕНЫ</small><strong>{devices?.shift.message||'Проверяем состояние локальной и фискальной смены…'}</strong></div>
          {!devices?.shift.ready&&<p>До начала продаж нужно устранить несоответствие локальной смены и смены ККТ.</p>}
        </section>
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
          unresolved.map((operation)=>{const text=recoveryText(operation);return <article key={operation.id} className={text.critical?'critical':''}>
            <div><b>{text.title}</b><small>{operation.kind==='sale'?'Продажа':'Возврат'} · {new Date(operation.createdAt).toLocaleString('ru-RU')}</small></div>
            <div><strong>{text.detail}</strong>{operation.lastError&&<small>{operation.lastError}</small>}</div>
            <button onClick={()=>recover(operation.id)}>Проверить и продолжить</button>
          </article>})}
        </section>
        <section className="recovery-list print-recovery-list">
          <h3>Товарные чеки, ожидающие печати</h3>
          {!printJobs.length?<div className="recovery-empty"><strong>Очередь пуста</strong><span>Все товарные чеки напечатаны.</span></div>:
          printJobs.map((job)=><article key={job.id} className={job.state==='error'?'critical':''}>
            <div><b>Товарный чек не напечатан</b><small>Попыток: {job.attempts} · {new Date(job.createdAt).toLocaleString('ru-RU')}</small></div>
            <div><strong>Продажа уже сохранена и не будет отменена.</strong>{job.lastError&&<small>{job.lastError}</small>}</div>
            <button onClick={()=>retryPrint(job.id)}>Повторить печать</button>
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
