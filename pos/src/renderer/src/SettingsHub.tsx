import { useEffect, useMemo, useState } from 'react'
import type { BootState, ConnectionConfig, ConnectionStatus, DeviceStatuses, DiagnosticEvent, InpasSettings, PrintJobSummary, PrinterInfo, UnresolvedOperation } from '../../shared/contracts'
import './settings-hub.css'

type AtolSettings={enabled:boolean;baseUrl:string;taxationType:string;taxType:string;operatorName?:string}
type ExtendedPosApi=typeof window.raspechatkaPos&{
  getAtolSettings:()=>Promise<AtolSettings>
  saveAtolSettings:(value:AtolSettings)=>Promise<AtolSettings>
}
const pos=()=>window.raspechatkaPos as ExtendedPosApi
const defaultAtol:AtolSettings={enabled:false,baseUrl:'http://127.0.0.1:16732/api/v2',taxationType:'patent',taxType:'none',operatorName:''}
const defaultInpas:InpasSettings={enabled:false,executablePath:'',terminalId:'',currencyCode:'643',timeoutMs:3600000,qrMode:'terminal_choice'}

export default function SettingsHub(){
  const [gateOpen,setGateOpen]=useState(false)
  const [open,setOpen]=useState(false)
  const [password,setPassword]=useState('')
  const [gateError,setGateError]=useState('')
  const [boot,setBoot]=useState<BootState|null>(null)
  const [connection,setConnection]=useState<ConnectionStatus|null>(null)
  const [devices,setDevices]=useState<DeviceStatuses|null>(null)
  const [atol,setAtol]=useState<AtolSettings>(defaultAtol)
  const [inpas,setInpas]=useState<InpasSettings>(defaultInpas)
  const [printers,setPrinters]=useState<PrinterInfo[]>([])
  const [printer,setPrinter]=useState('')
  const [operations,setOperations]=useState<UnresolvedOperation[]>([])
  const [printJobs,setPrintJobs]=useState<PrintJobSummary[]>([])
  const [diagnostics,setDiagnostics]=useState<DiagnosticEvent[]>([])
  const [pairing,setPairing]=useState<ConnectionConfig>({serverUrl:'https://os.rpechatka.ru',deviceId:'',token:''})
  const [showPairing,setShowPairing]=useState(false)
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)

  useEffect(()=>{
    const handler=(event:MouseEvent)=>{
      const target=(event.target as HTMLElement|null)?.closest<HTMLButtonElement>('button')
      if(!target)return
      const navButtons=Array.from(document.querySelectorAll<HTMLButtonElement>('.main-nav>button'))
      const isSettings=navButtons[5]===target||Boolean(target.closest('.top-status'))
      if(!isSettings)return
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation()
      setPassword('');setGateError('');setGateOpen(true)
    }
    document.addEventListener('click',handler,true)
    return()=>document.removeEventListener('click',handler,true)
  },[])

  const refresh=async()=>{
    const [nextBoot,nextConnection,nextDevices,nextAtol,nextInpas,nextPrinters,nextPrinter,nextOperations,nextPrintJobs,nextDiagnostics]=await Promise.all([
      pos().getBootState(),pos().getConnectionStatus(),pos().getDeviceStatuses(),pos().getAtolSettings(),pos().getInpasSettings(),
      pos().listPrinters(),pos().getSelectedPrinter(),pos().listUnresolvedOperations(),pos().listPrintJobs(),pos().listDiagnosticEvents(80)
    ])
    setBoot(nextBoot);setConnection(nextConnection);setDevices(nextDevices);setAtol(nextAtol);setInpas(nextInpas)
    setPrinters(nextPrinters);setPrinter(nextPrinter||'');setOperations(nextOperations);setPrintJobs(nextPrintJobs);setDiagnostics(nextDiagnostics)
    setPairing((current)=>({...current,serverUrl:nextConnection.serverUrl||current.serverUrl,deviceId:nextConnection.deviceId||current.deviceId,token:''}))
  }

  useEffect(()=>{
    if(!open)return
    void refresh().catch((error)=>setMessage(error instanceof Error?error.message:String(error)))
    const timer=window.setInterval(()=>void refresh().catch(()=>undefined),10000)
    return()=>window.clearInterval(timer)
  },[open])

  const unlock=()=>{
    if(password!=='0000'){setGateError('Неверный пароль');return}
    setGateOpen(false);setOpen(true);setPassword('');void refresh()
  }
  const close=()=>{setOpen(false);setShowPairing(false);setMessage('')}

  const saveConnection=async()=>{
    setBusy(true);setMessage('Проверяем подключение к Распечатка OS…')
    try{
      await pos().saveConnection({...pairing,cashierId:undefined})
      const next=await pos().syncNow();setBoot(next);setShowPairing(false);setPairing((x)=>({...x,token:''}))
      await refresh();setMessage('Касса подключена к точке '+next.pointName)
    }catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  const selectCashier=async(id:string)=>{
    if(!id)return
    setBusy(true)
    try{const next=await pos().setActiveCashier(id);setBoot(next);await refresh();setMessage('Кассир: '+next.cashierName)}
    catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  const syncNow=async()=>{
    setBusy(true);setMessage('Синхронизация…')
    try{const next=await pos().syncNow();setBoot(next);await refresh();setMessage('Синхронизация завершена')}
    catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  const saveAtol=async()=>{try{setAtol(await pos().saveAtolSettings(atol));setMessage('Настройки АТОЛ сохранены');await refresh()}catch(e){setMessage(e instanceof Error?e.message:String(e))}}
  const saveInpas=async()=>{try{setInpas(await pos().saveInpasSettings(inpas));setMessage('Настройки INPAS сохранены');await refresh()}catch(e){setMessage(e instanceof Error?e.message:String(e))}}
  const selectPrinter=async(name:string)=>{try{await pos().setSelectedPrinter(name);setPrinter(name);setMessage('Принтер сохранён');await refresh()}catch(e){setMessage(e instanceof Error?e.message:String(e))}}
  const terminal=async(kind:'test'|'reconcile')=>{try{const result=kind==='test'?await pos().testPaymentTerminal():await pos().reconcilePaymentTerminal();setMessage(result.message);await refresh()}catch(e){setMessage(e instanceof Error?e.message:String(e))}}
  const recover=async(id:string)=>{try{const result=await pos().recoverOperation(id);setMessage(result.message);await refresh()}catch(e){setMessage(e instanceof Error?e.message:String(e))}}
  const retryPrint=async(id:string)=>{try{const result=await pos().retryPrintJob(id);setMessage(result.message);await refresh()}catch(e){setMessage(e instanceof Error?e.message:String(e))}}

  const statusItems=useMemo(()=>devices?[['OS',devices.os.ready,devices.os.message],['ККТ',devices.fiscal.ready,devices.fiscal.message],['Эквайринг',devices.payment.ready,devices.payment.message],['Принтер',devices.printer.ready,devices.printer.message],['Смена',devices.shift.ready,devices.shift.message]] as const:[],[devices])

  return <>
    {gateOpen&&<div className="settings-gate-backdrop"><form className="settings-gate" onSubmit={(e)=>{e.preventDefault();unlock()}}>
      <small>ЗАЩИЩЁННЫЙ РАЗДЕЛ</small><h2>Настройки кассы</h2><p>Введите пароль администратора.</p>
      <input autoFocus type="password" inputMode="numeric" maxLength={4} value={password} onChange={(e)=>setPassword(e.target.value.replace(/\D/g,'').slice(0,4))} placeholder="••••"/>
      {gateError&&<div className="settings-error">{gateError}</div>}
      <div><button type="button" onClick={()=>setGateOpen(false)}>Отмена</button><button className="primary" type="submit">Войти</button></div>
    </form></div>}

    {open&&<div className="settings-hub">
      <header className="settings-hub-header"><div><small>ТЕХНИЧЕСКИЙ РАЗДЕЛ</small><h1>Настройки кассы</h1><p>Подключение точки, оборудование, статусы и диагностика — всё в одном месте.</p></div><button onClick={close}>×</button></header>
      <div className="settings-hub-body">
        <section className="settings-section status-section"><div className="section-heading"><div><h2>Состояние кассы</h2><p>Обновляется автоматически каждые 10 секунд.</p></div><button onClick={()=>void refresh()}>Обновить</button></div>
          <div className="settings-status-grid">{statusItems.map(([label,ready,text])=><article key={label} className={ready?'ready':'bad'}><i/ ><div><b>{label}</b><span>{text}</span></div></article>)}</div>
        </section>

        <section className="settings-section"><div className="section-heading"><div><h2>Распечатка OS и точка</h2><p>Точка определяется Device ID, созданным в OS. В Windows выбрать другую точку нельзя.</p></div>{connection?.configured&&<button onClick={()=>setShowPairing((x)=>!x)}>{showPairing?'Отмена':'Переподключить'}</button>}</div>
          {connection?.configured&&!showPairing?<div className="connection-summary">
            <div><small>СТАТУС</small><b>{boot?.online?'На связи':'Локальный режим'}</b></div><div><small>ТОЧКА</small><b>{boot?.source==='frappe'?boot.pointName:'Ожидает синхронизации'}</b></div><div><small>РАБОЧЕЕ МЕСТО</small><b>{boot?.workstationName||'—'}</b></div><div><small>DEVICE ID</small><b>{connection.deviceId||'—'}</b></div>
            <div><small>ПОСЛЕДНЯЯ СИНХРОНИЗАЦИЯ</small><b>{boot?.lastSyncAt?new Date(boot.lastSyncAt).toLocaleString('ru-RU'):'Ещё не было'}</b></div><div><small>ОЧЕРЕДЬ</small><b>{boot?.pendingSync||0}</b></div>
          </div>:<div className="settings-form-grid"><label><span>Адрес OS</span><input value={pairing.serverUrl} onChange={(e)=>setPairing({...pairing,serverUrl:e.target.value})}/></label><label><span>Device ID</span><input value={pairing.deviceId||''} onChange={(e)=>setPairing({...pairing,deviceId:e.target.value})} placeholder="POS-…"/></label><label className="wide"><span>Token</span><input type="password" value={pairing.token||''} onChange={(e)=>setPairing({...pairing,token:e.target.value})} placeholder="Показывается в OS один раз"/></label><button className="primary wide" disabled={busy||!pairing.deviceId?.trim()||!pairing.token?.trim()} onClick={()=>void saveConnection()}>Подключить кассу</button></div>}
          {boot?.employees.length?<div className="cashier-row"><label><span>Сотрудник этой точки</span><select value={connection?.cashierId||''} disabled={Boolean(boot.shift)||busy} onChange={(e)=>void selectCashier(e.target.value)}><option value="">Выберите сотрудника</option>{boot.employees.map((x)=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><button disabled={busy||!connection?.configured} onClick={()=>void syncNow()}>Синхронизировать сейчас</button>{boot.shift&&<small>Сменить сотрудника можно только после закрытия смены.</small>}</div>:connection?.configured&&<div className="settings-warning">К этой точке не прикреплены активные сотрудники.</div>}
          {connection?.lastError&&<div className="settings-error">{connection.lastError}</div>}
        </section>

        <section className="settings-section"><div className="section-heading"><div><h2>ККТ АТОЛ</h2><p>АТОЛ 1Ф через локальный Web Server Драйвера ККТ 10.</p></div><label className="toggle"><input type="checkbox" checked={atol.enabled} onChange={(e)=>setAtol({...atol,enabled:e.target.checked})}/> Использовать АТОЛ</label></div>
          <div className="settings-form-grid"><label><span>Адрес Web Server</span><input value={atol.baseUrl} onChange={(e)=>setAtol({...atol,baseUrl:e.target.value})}/></label><label><span>СНО</span><select value={atol.taxationType} onChange={(e)=>setAtol({...atol,taxationType:e.target.value})}><option value="patent">Патент</option><option value="usnIncome">УСН доход</option><option value="usnIncomeOutcome">УСН доход − расход</option><option value="osn">ОСН</option></select></label><label><span>НДС</span><select value={atol.taxType} onChange={(e)=>setAtol({...atol,taxType:e.target.value})}><option value="none">Без НДС</option><option value="vat0">0%</option><option value="vat5">5%</option><option value="vat7">7%</option><option value="vat10">10%</option><option value="vat20">20%</option><option value="vat22">22%</option></select></label><label><span>Кассир для ККТ</span><input value={atol.operatorName||''} onChange={(e)=>setAtol({...atol,operatorName:e.target.value})}/></label></div><button className="primary section-action" onClick={()=>void saveAtol()}>Сохранить и проверить АТОЛ</button>
        </section>

        <section className="settings-section"><div className="section-heading"><div><h2>Эквайринг INPAS / PAX</h2><p>Интеграция через официальный DC Console.exe.</p></div><label className="toggle"><input type="checkbox" checked={inpas.enabled} onChange={(e)=>setInpas({...inpas,enabled:e.target.checked})}/> Использовать INPAS</label></div>
          <div className="settings-form-grid"><label className="wide"><span>Путь к DC Console.exe</span><input value={inpas.executablePath} onChange={(e)=>setInpas({...inpas,executablePath:e.target.value})} placeholder="Можно оставить пустым для автопоиска"/></label><label><span>ID терминала</span><input value={inpas.terminalId} onChange={(e)=>setInpas({...inpas,terminalId:e.target.value})}/></label><label><span>Таймаут, сек.</span><input type="number" min="30" max="3600" value={Math.round(inpas.timeoutMs/1000)} onChange={(e)=>setInpas({...inpas,timeoutMs:Number(e.target.value)*1000})}/></label></div><div className="settings-actions"><button className="primary" onClick={()=>void saveInpas()}>Сохранить INPAS</button><button onClick={()=>void terminal('test')}>Проверить связь</button><button onClick={()=>void terminal('reconcile')}>Сверка итогов</button></div>
        </section>

        <section className="settings-section"><div className="section-heading"><div><h2>Принтер товарного чека</h2><p>Любой установленный Windows-принтер.</p></div></div><label className="printer-row"><span>Принтер</span><select value={printer} onChange={(e)=>void selectPrinter(e.target.value)}><option value="">Не выбран</option>{printers.map((x)=><option key={x.name} value={x.name}>{x.name}{x.isDefault?' · по умолчанию':''}</option>)}</select></label></section>

        <section className="settings-section"><div className="section-heading"><div><h2>Незавершённые операции</h2><p>Оплаты, фискализация и печать, которые требуют внимания.</p></div><b>{operations.length+printJobs.length}</b></div>
          {!operations.length&&!printJobs.length?<div className="settings-ok">Нет операций, требующих восстановления.</div>:<div className="settings-recovery-list">{operations.map((x)=><article key={x.id}><div><b>{x.kind==='sale'?'Продажа':'Возврат'} · {x.state}</b><span>{x.lastError||'Операция сохранена локально'}</span></div><button onClick={()=>void recover(x.id)}>Проверить и продолжить</button></article>)}{printJobs.map((x)=><article key={x.id}><div><b>Товарный чек · {x.state}</b><span>{x.lastError||'Ожидает печати'}</span></div><button onClick={()=>void retryPrint(x.id)}>Повторить печать</button></article>)}</div>}
        </section>

        <section className="settings-section"><div className="section-heading"><div><h2>Диагностика</h2><p>Последние технические события приложения.</p></div><button onClick={()=>void refresh()}>Обновить</button></div><div className="settings-log">{diagnostics.slice(0,40).map((x)=><article key={x.id} className={x.level}><time>{new Date(x.createdAt).toLocaleString('ru-RU')}</time><div><b>{x.source} · {x.eventType}</b><span>{x.message}</span></div></article>)}</div></section>
        {message&&<div className="settings-message">{message}</div>}
      </div>
    </div>}
  </>
}
