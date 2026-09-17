import { useEffect, useMemo, useState } from 'react'
import type { BootState, ConnectionStatus, DeviceStatuses } from '../../shared/contracts'
import './pilot-ux.css'

type AtolSettings={enabled:boolean;baseUrl:string;taxationType:string;taxType:string;operatorName?:string}
type ExtendedPosApi=typeof window.raspechatkaPos&{getAtolSettings:()=>Promise<AtolSettings>}
const pos=()=>window.raspechatkaPos as ExtendedPosApi

type Snapshot={boot:BootState;connection:ConnectionStatus;devices:DeviceStatuses;printer?:string;atol:AtolSettings}

export default function PilotReadiness(){
  const [open,setOpen]=useState(false)
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null)
  const [error,setError]=useState('')

  const refresh=async()=>{
    try{
      const [boot,connection,devices,printer,atol]=await Promise.all([
        pos().getBootState(),pos().getConnectionStatus(),pos().getDeviceStatuses(),pos().getSelectedPrinter(),pos().getAtolSettings()
      ])
      setSnapshot({boot,connection,devices,printer,atol});setError('')
    }catch(e){setError(e instanceof Error?e.message:String(e))}
  }

  useEffect(()=>{
    void refresh()
    const acknowledged=localStorage.getItem('raspechatka-pos-readiness-seen-v1')==='1'
    if(!acknowledged)setOpen(true)
  },[])

  const items=useMemo(()=>{
    if(!snapshot)return []
    const osReady=snapshot.connection.configured&&(snapshot.boot.source==='frappe'||Boolean(snapshot.boot.lastSyncAt))
    const fiscalReady=snapshot.atol.enabled&&snapshot.devices.fiscal.ready
    const printerReady=Boolean(snapshot.printer)&&snapshot.devices.printer.ready
    const paymentReady=snapshot.devices.payment.ready
    const shiftSafe=snapshot.devices.shift.ready
    return [
      {key:'os',label:'Распечатка OS',critical:true,ready:osReady,text:osReady?(snapshot.boot.online?'Подключена и на связи':'Настроена; сейчас работаем локально'):'Нужно подключить рабочее место и выполнить первую синхронизацию'},
      {key:'fiscal',label:'ККТ АТОЛ',critical:true,ready:fiscalReady,text:fiscalReady?snapshot.devices.fiscal.message:(snapshot.atol.enabled?snapshot.devices.fiscal.message:'АТОЛ ещё не включён в настройках оборудования')},
      {key:'printer',label:'Товарный принтер',critical:false,ready:printerReady,text:printerReady?`Выбран: ${snapshot.printer}`:'Не выбран. Продажу это не отменяет, но товарный чек печататься не будет'},
      {key:'payment',label:'Эквайринг',critical:false,ready:paymentReady,text:paymentReady?snapshot.devices.payment.message:'Пока не готов. Наличные и подтверждённая удалённая оплата могут работать без него'},
      {key:'shift',label:'Состояние смены',critical:true,ready:shiftSafe,text:snapshot.devices.shift.message}
    ]
  },[snapshot])
  const criticalReady=items.filter((x)=>x.critical).every((x)=>x.ready)
  const warnings=items.filter((x)=>!x.critical&&!x.ready).length

  const openEquipment=()=>{setOpen(false);document.querySelector<HTMLButtonElement>('.recovery-button')?.click()}
  const openConnection=()=>{setOpen(false);document.querySelectorAll<HTMLButtonElement>('.main-nav>button')[5]?.click()}
  const close=()=>{localStorage.setItem('raspechatka-pos-readiness-seen-v1','1');setOpen(false)}

  return <>
    <button className={'pilot-floating readiness-button '+(criticalReady?'ready':'attention')} onClick={()=>{setOpen(true);void refresh()}}>
      {criticalReady?(warnings?`Касса готова · ${warnings} предупрежд.`:'✓ Касса готова'):'! Проверить готовность'}
    </button>
    {open&&<div className="pilot-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget)close()}}>
      <section className="pilot-modal readiness-modal">
        <header><div><small>ПЕРВЫЙ ЗАПУСК / ДИАГНОСТИКА</small><h2>Готовность рабочего места</h2></div><button onClick={close}>×</button></header>
        <div className={'readiness-hero '+(criticalReady?'ready':'blocked')}>
          <strong>{criticalReady?'Критические системы готовы':'Касса ещё не готова к безопасной работе'}</strong>
          <span>{criticalReady?'Можно переходить к рабочей смене. Жёлтые пункты не блокируют продажу.':'Исправьте красные пункты. Жёлтые можно завершить позже.'}</span>
        </div>
        <div className="readiness-list">{items.map((item)=><article key={item.key} className={item.ready?'ready':item.critical?'blocked':'warning'}>
          <i>{item.ready?'✓':item.critical?'!':'•'}</i><div><b>{item.label}</b><span>{item.text}</span></div><strong>{item.ready?'Готово':item.critical?'Нужно исправить':'Необязательно'}</strong>
        </article>)}</div>
        {error&&<div className="pilot-message error">{error}</div>}
        <div className="readiness-actions"><button onClick={openConnection}>Подключение к OS</button><button onClick={openEquipment}>Оборудование</button><button onClick={()=>void refresh()}>Проверить снова</button><button className="primary" onClick={close}>{criticalReady?'Перейти к кассе':'Закрыть'}</button></div>
        <small className="readiness-note">Интернет и товарный принтер не являются причиной отменять уже проведённую продажу. ККТ и согласованное состояние смены — критические.</small>
      </section>
    </div>}
  </>
}
