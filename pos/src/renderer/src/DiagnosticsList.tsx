import { useEffect, useState } from 'react'
import type { DiagnosticEvent } from '../../shared/contracts'

const sourceNames:Record<DiagnosticEvent['source'],string>={
  app:'Приложение',shift:'Смена',payment:'Оплата',fiscal:'ККТ',printer:'Принтер',sync:'OS',recovery:'Восстановление'
}

export default function DiagnosticsList(){
  const [events,setEvents]=useState<DiagnosticEvent[]>([])
  const [open,setOpen]=useState(false)

  const refresh=()=>window.raspechatkaPos.listDiagnosticEvents(100).then(setEvents).catch(()=>setEvents([]))
  useEffect(()=>{if(open)void refresh()},[open])

  return <section className="diagnostics-list">
    <header>
      <div><h3>Журнал кассы</h3><p>Локальная история работы ККТ, смен, печати, синхронизации и восстановления. Нужна для разбора сбоев без догадок.</p></div>
      <button onClick={()=>setOpen((value)=>!value)}>{open?'Скрыть':'Показать журнал'}</button>
    </header>
    {open&&<>
      <div className="diagnostics-toolbar"><span>Последние {events.length} событий</span><button onClick={()=>void refresh()}>Обновить</button></div>
      <div className="diagnostics-events">
        {!events.length?<div className="recovery-empty"><strong>Журнал пока пуст</strong><span>События появятся после работы с кассой.</span></div>:
        events.map((event)=><article key={event.id} className={'diagnostic-event '+event.level}>
          <time>{new Date(event.createdAt).toLocaleString('ru-RU')}</time>
          <div><b>{sourceNames[event.source]}</b><strong>{event.message}</strong>{event.operationId&&<small>Операция: {event.operationId}</small>}</div>
        </article>)}
      </div>
    </>}
  </section>
}
