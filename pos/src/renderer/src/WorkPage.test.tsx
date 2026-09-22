import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkplaceData, WorkScheduleEntry } from '../../shared/contracts'
import WorkPage, { scheduleCellPresentation, shiftDisplayLabel } from './WorkPage'

const entry=(id:string,date:string,shiftCode:string,shiftName:string):WorkScheduleEntry=>({
  id,date,employeeId:'employee-1',employeeName:'Иван Иванов',shiftTemplate:shiftName,
  shiftCode,shiftName,startTime:shiftCode==='V'?'18:00:00':'09:00:00',
  endTime:shiftCode==='V'?'23:00:00':'18:00:00',plannedHours:shiftCode==='V'?5:8,
})

const workplace:WorkplaceData={
  schedule:[],
  scheduleMonth:{
    month:'2026-09',days:2,employees:[{id:'employee-1',name:'Иван Иванов'}],
    entries:[
      entry('morning','2026-09-01','U','Утренняя'),
      entry('evening','2026-09-01','V','Вечерняя'),
      entry('evening-only','2026-09-02','V','Вечерняя'),
    ],
  },
  myUpcomingShifts:[entry('upcoming','2026-09-03','U','Утренняя')],
  operationalCatalog:[],deliveries:[],supplyRequests:[],
  cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},
  orders:[],
}

describe('WorkPage schedule presentation',()=>{
  it('maps backend U/V codes and combined cells without changing the source values',()=>{
    const morning=entry('u','2026-09-01','U','Утренняя')
    const evening=entry('v','2026-09-01','V','Вечерняя')

    expect(shiftDisplayLabel(morning.shiftCode,morning.shiftName)).toBe('У')
    expect(shiftDisplayLabel(evening.shiftCode,evening.shiftName)).toBe('В')
    expect(scheduleCellPresentation([morning])).toEqual({
      label:'У',className:'schedule-mark schedule-shift-morning',
    })
    expect(scheduleCellPresentation([evening])).toEqual({
      label:'В',className:'schedule-mark schedule-shift-evening',
    })
    expect(scheduleCellPresentation([morning,evening])).toEqual({
      label:'У/В',className:'schedule-mark schedule-shift-both',
    })
    expect(morning.shiftCode).toBe('U')
    expect(evening.shiftCode).toBe('V')
  })

  it('keeps legacy workplace labels compatible when shiftCode is empty or unknown',()=>{
    expect(shiftDisplayLabel('', 'Старшая смена')).toBe('Старшая смена')
    expect(scheduleCellPresentation([
      {...entry('legacy','2026-09-01','','Старшая смена'),shiftCode:''},
    ])).toEqual({
      label:'Старшая смена',className:'schedule-mark schedule-shift-other',
    })
  })

  it('renders the full point graph before upcoming shifts and remains read-only',()=>{
    const markup=renderToStaticMarkup(
      <WorkPage products={[]} data={workplace} shiftOpen={false} onChanged={async()=>undefined} notify={()=>undefined}/>,
    )

    expect(markup.indexOf('График точки')).toBeLessThan(markup.indexOf('Мои ближайшие 5 смен'))
    expect(markup).toContain('schedule-shift-both')
    expect(markup).toContain('>У/В<')
    expect(markup).toContain('schedule-shift-evening')
    expect(markup).toContain('>В<')
    expect(markup).toContain('Только просмотр')
    expect(markup).toContain('сентябрь 2026 г.')
    expect(markup).not.toContain('<select')
    expect(markup).not.toContain('<input')
    expect(markup).not.toContain('Сохранить')
    expect(markup).not.toContain('Редактировать')
  })

  it('uses the exact TeamPage color and diagonal semantics',()=>{
    const css=readFileSync(new URL('./workplace.css',import.meta.url),'utf8')
    expect(css).toContain('.schedule-shift-morning{background:#fff4a8}')
    expect(css).toContain('.schedule-shift-evening{background:#a9cef7}')
    expect(css).toContain('.schedule-shift-both{background:linear-gradient(135deg,#fff4a8 0 50%,#a9cef7 50% 100%)}')
    expect(css).toContain('.work-schedule{display:grid;grid-template-columns:minmax(0,1fr)')
  })
})
