import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkplaceData, WorkScheduleEntry } from '../../shared/contracts'
import WorkPage, { scheduleCellPresentation, shiftDisplayLabel, WarehouseWorkspace } from './WorkPage'

const entry=(id:string,date:string,shiftCode:string,shiftName:string):WorkScheduleEntry=>({
  id,date,employeeId:'employee-1',employeeName:'Иван Иванов',shiftTemplate:shiftName,
  shiftCode,shiftName,startTime:shiftCode==='V'?'18:00:00':'09:00:00',
  endTime:shiftCode==='V'?'23:00:00':'18:00:00',plannedHours:shiftCode==='V'?5:8,
})

const workplace:WorkplaceData={
  schedule:[],
  scheduleMonth:{
    month:'2026-09',days:2,employees:[{id:'employee-1',name:'Иванов Иван Иванович'}],
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
    expect(markup).toContain('>Иванов И. И.<')
    expect(markup).not.toContain('>Иванов Иван Иванович<')
    expect(markup).toContain('class="upcoming-shift"')
    expect(markup).toContain('datetime="2026-09-03"')
    expect(markup).toContain('>09:00–18:00<')
    expect(markup).toContain('>8 ч.<')
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
    expect(css).toContain('.schedule-upcoming>.upcoming-shift{display:grid;')
    expect(css).toContain('grid-template-columns:repeat(auto-fit,minmax(250px,1fr))')
  })
})

describe('WarehouseWorkspace stacked layout',()=>{
  const warehouseData:WorkplaceData={
    ...workplace,
    operationalCatalog:[
      {id:'paper-a4',name:'Бумага А4',itemCode:'PAPER-A4',itemType:'Product',uom:'пачка',trackInventory:true,stock:7,storageAddress:'Стеллаж 2'},
    ],
    deliveries:[{
      id:'PO-17',supplier:'Поставщик бумаги',status:'Ожидается',expectedDate:'2026-09-25',comment:'Доставка утром',
      items:[{
        purchaseOrderItemId:'POI-1',itemId:'paper-a4',itemName:'Бумага А4',itemCode:'PAPER-A4',
        uom:'пачка',orderedQuantity:10,receivedQuantity:2,remainingQuantity:8,
      }],
    }],
  }

  it('renders actions, deliveries and stock as ordered full-width blocks without work-grid',()=>{
    const markup=renderToStaticMarkup(
      <WarehouseWorkspace data={warehouseData} onChanged={async()=>undefined} notify={()=>undefined}/>,
    )
    const actions=markup.indexOf('data-workplace-block="actions"')
    const deliveries=markup.indexOf('data-workplace-block="deliveries"')
    const stock=markup.indexOf('data-workplace-block="stock"')

    expect(actions).toBeGreaterThanOrEqual(0)
    expect(actions).toBe(35)
    expect(actions).toBeLessThan(deliveries)
    expect(deliveries).toBeLessThan(stock)
    expect(markup).toContain('class="warehouse-workspace"')
    expect(markup).not.toContain('work-grid')
    expect(markup).not.toContain('Товары и склад')
    expect(markup).not.toContain('Остатки и поставки текущей точки')
  })

  it('preserves action buttons, delivery summary, search and stock/storage content',()=>{
    const markup=renderToStaticMarkup(
      <WarehouseWorkspace data={warehouseData} onChanged={async()=>undefined} notify={()=>undefined}/>,
    )

    expect(markup).toContain('>Списать брак<')
    expect(markup).toContain('>Потребность точки<')
    expect(markup).toContain('№ PO-17')
    expect(markup).toContain('Поставщик бумаги')
    expect(markup).toContain('Доставка утром')
    expect(markup).toContain('25.09.2026')
    expect(markup).toContain('Ожидается')
    expect(markup).toContain('Осталось принять: 1 поз.')
    expect(markup).toContain('8 пачка')
    expect(markup).toContain('>Создать приёмку<')
    expect(markup).toContain('placeholder="Название, ID или код"')
    expect(markup).toContain('Бумага А4')
    expect(markup).toContain('PAPER-A4')
    expect(markup).toContain('7 пачка')
    expect(markup).toContain('Стеллаж 2')
  })

  it('keeps the existing warehouse callbacks wired without new transport semantics',()=>{
    const source=readFileSync(new URL('./WorkPage.tsx',import.meta.url),'utf8')
    expect(source).toContain('onClick={()=>setWriteOff(true)}')
    expect(source).toContain('onClick={()=>setNeed(true)}')
    expect(source).toContain('onReceive={()=>setReceiveOrder(order)}')
    expect(source).toContain('window.raspechatkaPos.reportStockWriteOff(request)')
    expect(source).toContain('window.raspechatkaPos.createSupplyRequest(request)')
    expect(source).toContain('window.raspechatkaPos.createStockReceipt(request)')
  })

  it('keeps page width fluid and limits horizontal overflow to the stock table',()=>{
    const css=readFileSync(new URL('./workplace.css',import.meta.url),'utf8')
    expect(css).toContain('.warehouse-workspace{display:flex;flex-direction:column;')
    expect(css).toContain('.warehouse-deliveries,.warehouse-stock{width:100%;min-width:0;margin:0}')
    expect(css).toContain('.stock-table-scroll{width:100%;overflow-x:auto}')
    expect(css).not.toContain('.warehouse-workspace{display:grid')
    expect(css).toContain('.warehouse-action{min-height:50px;')
    expect(css).toContain('.warehouse-action-writeoff{border-color:#cf7770;background:#fff1ef;color:#8f2923}')
    expect(css).toContain('.warehouse-action-need{border-color:#789c13;background:var(--rp-green);color:#fff}')
    expect(css).toContain('.warehouse-workspace .work-card{border-radius:0}')
    expect(css).toContain('.delivery-card{display:grid;')
    expect(css).toContain('border-radius:0;background:#fff')
  })
})

