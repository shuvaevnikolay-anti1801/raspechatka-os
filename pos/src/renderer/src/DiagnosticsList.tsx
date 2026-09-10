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

  return <>
    <button className="diagnostics-fab" onClick={()=>setOpen(true)} title="Журнал кассы">Журнал</button>
    {open&&<div className="diagnostics-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget)setOpen(false)}}>
      <section className="diagnostics-panel">
        <header>
          <div><small>ДИАГНОСТИКА</small><h2>Журнал кассы</h2><p>Локальная история ККТ, смен, печати, синхронизации и восстановления.</p></div>
          <button onClick={()=>setOpen(false)}>×</button>
        </header>
        <div className="diagnostics-toolbar"><span>Последние {events.length} событий</span><button onClick={()=>void refresh()}>Обновить</button></div>
        <div className="diagnostics-events">
          {!events.length?<div className="diagnostics-empty"><strong>Журнал пока пуст</strong><span>События появятся после работы с кассой.</span></div>:
          events.map((event)=><article key={event.id} className={'diagnostic-event '+event.level}>
            <time>{new Date(event.createdAt).toLocaleString('ru-RU')}</time>
            <div><b>{sourceNames[event.source]}</b><strong>{event.message}</strong>{event.operationId&&<small>Операция: {event.operationId}</small>}</div>
          </article>)}
        </div>
      </section>
    </div>}
  </>
}
