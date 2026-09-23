import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { WorkplaceData, WorkScheduleEntry } from '../../shared/contracts'
import WorkPage, {
  buildStockReceiptRequest,
  groupUpcomingShifts,
  ReceiveModal,
  scheduleCellPresentation,
  shiftDisplayLabel,
  upcomingShiftLabel,
  SupplyRequestModal,
  warehouseItemMatches,
  WarehouseWorkspace,
  WriteOffModal,
} from './WorkPage'

const entry=(id:string,date:string,shiftCode:string,shiftName:string):WorkScheduleEntry=>({
  id,date,employeeId:'employee-1',employeeName:'Иван Иванов',shiftTemplate:shiftName,
  shiftCode,shiftName,startTime:shiftCode==='V'?'18:00:00':'09:00:00',
  endTime:shiftCode==='V'?'23:00:00':'18:00:00',plannedHours:shiftCode==='V'?5:8,
})

const septemberSchedule={
  month:'2026-09',days:30,employees:[{id:'employee-1',name:'Иванов Иван Иванович'}],
  entries:[
    entry('morning','2026-09-01','U','Утренняя'),
    entry('evening','2026-09-01','V','Вечерняя'),
    entry('evening-only','2026-09-02','V','Вечерняя'),
  ],
}
const octoberSchedule={
  month:'2026-10',days:31,employees:[{id:'employee-1',name:'Иванов Иван Иванович'}],
  entries:[entry('october-morning','2026-10-01','U','Утренняя')],
}

const workplace:WorkplaceData={
  schedule:[],
  scheduleMonth:septemberSchedule,
  scheduleCurrentMonth:septemberSchedule,
  scheduleNextMonth:octoberSchedule,
  myUpcomingShifts:[
    entry('upcoming-morning','2026-09-23','U','Утренняя'),
    entry('upcoming-evening','2026-09-24','V','Вечерняя'),
    entry('upcoming-both-u','2026-09-25','U','Утренняя'),
    entry('upcoming-both-v','2026-09-25','V','Вечерняя'),
  ],
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
    expect(upcomingShiftLabel([morning])).toBe('Утро')
    expect(upcomingShiftLabel([evening])).toBe('Вечер')
    expect(upcomingShiftLabel([morning,evening])).toBe('Утро / вечер')
    expect(morning.shiftCode).toBe('U')
    expect(evening.shiftCode).toBe('V')
  })

  it('groups same-date upcoming U/V entries into one semantic card',()=>{
    const grouped=groupUpcomingShifts(workplace.myUpcomingShifts)
    expect(grouped).toHaveLength(3)
    expect(grouped[2].date).toBe('2026-09-25')
    expect(grouped[2].entries.map((item)=>item.shiftCode)).toEqual(['U','V'])
  })

  it('keeps legacy workplace labels compatible when shiftCode is empty or unknown',()=>{
    expect(shiftDisplayLabel('', 'Старшая смена')).toBe('Старшая смена')
    expect(scheduleCellPresentation([
      {...entry('legacy','2026-09-01','','Старшая смена'),shiftCode:''},
    ])).toEqual({
      label:'Старшая смена',className:'schedule-mark schedule-shift-other',
    })
  })

  it('renders upcoming shifts first with full weekday/date semantics and no time or hours in cards',()=>{
    const markup=renderToStaticMarkup(
      <WorkPage products={[]} data={workplace} shiftOpen={false} onChanged={async()=>undefined} notify={()=>undefined}/>,
    )
    const upcomingStart=markup.indexOf('schedule-upcoming')
    const currentMonthStart=markup.indexOf('сентябрь 2026 г.')
    const nextMonthStart=markup.indexOf('октябрь 2026 г.')
    const upcomingMarkup=markup.slice(upcomingStart,currentMonthStart)

    expect(upcomingStart).toBeGreaterThanOrEqual(0)
    expect(upcomingStart).toBeLessThan(currentMonthStart)
    expect(currentMonthStart).toBeLessThan(nextMonthStart)
    expect(upcomingMarkup).toContain('Мои ближайшие 5 смен')
    expect(upcomingMarkup).toContain('dateTime="2026-09-23"')
    expect(upcomingMarkup).toContain('>среда<')
    expect(upcomingMarkup).toContain('>23 сентября<')
    expect(upcomingMarkup).toContain('>Утро<')
    expect(upcomingMarkup).toContain('>Вечер<')
    expect(upcomingMarkup).toContain('>Утро / вечер<')
    expect(upcomingMarkup).not.toContain('09:00')
    expect(upcomingMarkup).not.toContain('18:00')
    expect(upcomingMarkup).not.toMatch(/>\d+(?:[.,]\d+)? ч\.</)
  })

  it('renders current then next month headings and keeps point schedules read-only',()=>{
    const markup=renderToStaticMarkup(
      <WorkPage products={[]} data={workplace} shiftOpen={false} onChanged={async()=>undefined} notify={()=>undefined}/>,
    )

    expect(markup.indexOf('сентябрь 2026 г.')).toBeLessThan(markup.indexOf('октябрь 2026 г.'))
    expect(markup.match(/Только просмотр/g)).toHaveLength(2)
    expect(markup).toContain('schedule-shift-both')
    expect(markup).toContain('>У/В<')
    expect(markup).toContain('schedule-shift-evening')
    expect(markup).toContain('>В<')
    expect(markup).toContain('>Иванов И. И.<')
    expect(markup).not.toContain('>Иванов Иван Иванович<')
    expect(markup).not.toContain('<select')
    expect(markup).not.toContain('<input')
    expect(markup).not.toContain('Сохранить')
    expect(markup).not.toContain('Редактировать')
  })

  it('renders explicit December to January rollover input in calendar order',()=>{
    const december={...septemberSchedule,month:'2026-12',days:31,entries:[]}
    const january={...octoberSchedule,month:'2027-01',days:31,entries:[]}
    const rollover:WorkplaceData={
      ...workplace,
      scheduleMonth:december,
      scheduleCurrentMonth:december,
      scheduleNextMonth:january,
      myUpcomingShifts:[],
    }
    const markup=renderToStaticMarkup(
      <WorkPage products={[]} data={rollover} shiftOpen={false} onChanged={async()=>undefined} notify={()=>undefined}/>,
    )

    expect(markup).toContain('Ближайших опубликованных смен пока нет.')
    expect(markup.indexOf('декабрь 2026 г.')).toBeLessThan(markup.indexOf('январь 2027 г.'))
  })

  it('shows a clear empty state for an empty month',()=>{
    const emptyNext={month:'2026-10',days:31,employees:[],entries:[]}
    const markup=renderToStaticMarkup(
      <WorkPage products={[]} data={{...workplace,scheduleNextMonth:emptyNext}} shiftOpen={false} onChanged={async()=>undefined} notify={()=>undefined}/>,
    )
    expect(markup).toContain('На октябрь 2026 г. опубликованного графика пока нет.')
  })

  it('keeps exact U/V colors while using readable responsive laptop sizing',()=>{
    const css=readFileSync(new URL('./workplace.css',import.meta.url),'utf8')
    const source=readFileSync(new URL('./WorkPage.tsx',import.meta.url),'utf8')

    expect(css).toContain('.schedule-shift-morning{background:#fff4a8}')
    expect(css).toContain('.schedule-shift-evening{background:#a9cef7}')
    expect(css).toContain('.schedule-shift-both{background:linear-gradient(135deg,#fff4a8 0 50%,#a9cef7 50% 100%)}')
    expect(css).toContain('.work-schedule{display:grid;grid-template-columns:minmax(0,1fr)')
    expect(css).toContain('grid-template-columns:repeat(auto-fit,minmax(260px,1fr))')
    expect(css).toContain('.upcoming-shift .schedule-mark{display:flex;align-items:center;justify-content:center;min-width:0;padding:0 var(--pos-space-3);font-size:var(--pos-type-body)')
    expect(source).toContain("minmax(clamp(40px,2.45vw,52px),1fr)")
    expect(css).toContain('@media (min-width:1100px) and (max-width:1279px)')
    expect(css).toContain('grid-template-columns:repeat(auto-fit,minmax(240px,1fr))')
    expect(css).toContain('@media (min-width:1600px)')
    expect(css).toContain('@media (max-height:760px)')
    expect(css).not.toMatch(/font-size:[0-9]px/)
  })
})

describe('WarehouseWorkspace design-system migration',()=>{
  const warehouseData:WorkplaceData={
    ...workplace,
    operationalCatalog:[
      {id:'paper-a4',name:'Бумага А4',itemCode:'PAPER-A4',itemType:'Product',uom:'пачка',trackInventory:true,stock:7,storageAddress:'Стеллаж 2'},
    ],
    deliveries:[{
      id:'PO-17',supplier:'Поставщик бумаги',status:'Ожидается',expectedDate:'2026-09-25',deliveryCompany:'СДЭК',deliveryCode:'1234',comment:'Доставка утром',
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
    expect(actions).toBeLessThan(deliveries)
    expect(deliveries).toBeLessThan(stock)
    expect(markup).toContain('class="warehouse-workspace"')
    expect(markup).not.toContain('work-grid')
    expect(markup).not.toContain('Остатки и поставки текущей точки')
  })

  it('uses Design Code primary/danger hierarchy and preserves warehouse content',()=>{
    const markup=renderToStaticMarkup(
      <WarehouseWorkspace data={warehouseData} onChanged={async()=>undefined} notify={()=>undefined}/>,
    )

    expect(markup).toContain('pos-button--danger')
    expect(markup).toContain('warehouse-action-writeoff')
    expect(markup).toContain('>Списать брак<')
    expect(markup).toContain('pos-button--primary')
    expect(markup).toContain('warehouse-action-need')
    expect(markup).toContain('>Заказать<')
    expect(markup).toContain('Поставщик бумаги')
    expect(markup).toContain('Доставка утром')
    expect(markup).toContain('Перевозчик: СДЭК')
    expect(markup).toContain('Код доставки: 1234')
    expect(markup).toContain('25.09.2026')
    expect(markup).toContain('Ожидается')
    expect(markup).toContain('Осталось принять: 1 поз.')
    expect(markup).toContain('8 пачка')
    expect(markup).toContain('>Создать приёмку<')
    expect(markup).toContain('placeholder="Название товара"')
    expect(markup).toContain('pos-field')
    expect(markup).toContain('Бумага А4')
    expect(markup).toContain('7 пачка')
    expect(markup).toContain('Стеллаж 2')
    expect(markup).not.toContain('PO-17')
    expect(markup).not.toContain('POI-1')
    expect(markup).not.toContain('PAPER-A4')
    expect(markup).not.toContain('paper-a4')
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

  it('keeps long data inside bounded scroll regions and removes legacy visual exceptions',()=>{
    const css=readFileSync(new URL('./workplace.css',import.meta.url),'utf8')

    expect(css).toContain('.warehouse-workspace{display:flex;flex-direction:column;')
    expect(css).toContain('.warehouse-deliveries,.warehouse-stock{width:100%;min-width:0;margin:0}')
    expect(css).toContain('.delivery-list-scroll{display:grid;')
    expect(css).toContain('.stock-table-scroll{width:100%;max-height:clamp(')
    expect(css).toContain('overflow-wrap:anywhere')
    expect(css).toContain('position:sticky;top:0')
    expect(css).not.toContain('@media(max-width:900px)')
    expect(css).not.toContain('#cf7770')
    expect(css).not.toContain('#789c13')
    expect(css).not.toContain('.warehouse-modal-header')
    expect(css).not.toContain('.warehouse-modal-actions')
    expect(css).not.toContain('.warehouse-field input')
  })
})

describe('Warehouse operational modals',()=>{
  const products=[{id:'paper-a4',name:'Бумага А4',itemCode:'PAPER-A4',itemType:'Product' as const,uom:'пачка',trackInventory:true,stock:7,storageAddress:'Стеллаж 2'}]
  const order={
    id:'PO-17',supplier:'Поставщик бумаги',status:'Ожидается',expectedDate:'2026-09-25',
    items:[{purchaseOrderItemId:'POI-1',itemId:'paper-a4',itemName:'Бумага А4',itemCode:'PAPER-A4',uom:'пачка',orderedQuantity:10,receivedQuantity:2,remainingQuantity:8}],
  }

  it('renders receiving context, bounded quantities and an obvious submit without changing defaults',()=>{
    const markup=renderToStaticMarkup(<ReceiveModal order={order} onClose={()=>undefined} onComplete={async()=>undefined}/>)

    expect(markup).toContain('pos-modal--matrix')
    expect(markup).toContain('warehouse-receive-modal')
    expect(markup).toContain('Заказ № PO-17')
    expect(markup).toContain('Поставщик бумаги')
    expect(markup).toContain('Осталось по заказу: 8 пачка')
    expect(markup).toContain('Количество, пачка')
    expect(markup).toContain('min="0"')
    expect(markup).toContain('max="8"')
    expect(markup).toContain('step="0.001"')
    expect(markup).toContain('value="8"')
    expect(markup).toContain('>Подтвердить приёмку<')
    expect(markup).toContain('aria-label="Закрыть"')
    expect(markup).toContain('aria-label="Убрать Бумага А4"')
  })

  it('keeps receipt payload bounds and exact request shape',()=>{
    expect(buildStockReceiptRequest('PO-17',[
      {purchaseOrderItemId:'valid',itemName:'Бумага',uom:'пачка',remainingQuantity:8,quantity:5},
      {purchaseOrderItemId:'too-much',itemName:'Бумага',uom:'пачка',remainingQuantity:8,quantity:9},
      {purchaseOrderItemId:'zero',itemName:'Бумага',uom:'пачка',remainingQuantity:8,quantity:0},
    ])).toEqual({purchaseOrderId:'PO-17',lines:[{purchaseOrderItemId:'valid',quantity:5}]})
  })

  it('renders searchable write-off selection with exact reasons and required comment',()=>{
    const markup=renderToStaticMarkup(<WriteOffModal products={products} onClose={()=>undefined} onComplete={async()=>undefined}/>)

    expect(markup).toContain('pos-modal--form')
    expect(markup).toContain('warehouse-writeoff-modal')
    expect(markup).toContain('role="combobox"')
    expect(markup).toContain('aria-autocomplete="list"')
    expect(markup).toContain('warehouse-product-options')
    expect(markup).toContain('Бумага А4')
    expect(markup).not.toContain('PAPER-A4')
    expect(markup).toContain('>Брак<')
    expect(markup).toContain('>Внутренние нужды<')
    expect(markup).toContain('>Обучение<')
    expect(markup).not.toContain('>Другое<')
    expect(markup).toContain('>Количество<')
    expect(markup).toContain('>Комментарий<')
    expect(markup).toContain('>обязательно<')
    expect(markup).toContain('required=""')
    expect(markup).toContain('>Подтвердить списание<')
  })

  it('keeps technical catalog keys searchable without rendering them in the selector',()=>{
    expect(warehouseItemMatches(products[0],'PAPER-A4')).toBe(true)
    expect(warehouseItemMatches(products[0],'paper-a4')).toBe(true)
    expect(warehouseItemMatches(products[0],'Бумага')).toBe(true)
    const markup=renderToStaticMarkup(<WriteOffModal products={products} onClose={()=>undefined} onComplete={async()=>undefined}/>)
    expect(markup).not.toContain('PAPER-A4')
    expect(markup).not.toContain('paper-a4')
  })

  it('renders quantity-less Заказать form with required comment and no technical catalog text',()=>{
    const markup=renderToStaticMarkup(<SupplyRequestModal products={products} onClose={()=>undefined} onComplete={async()=>undefined}/>)

    expect(markup).toContain('pos-modal--form')
    expect(markup).toContain('warehouse-supply-modal')
    expect(markup).toContain('>Заказать<')
    expect(markup).toContain('>Позиция из каталога<')
    expect(markup).toContain('>Наименование или описание<')
    expect(markup).not.toContain('>Количество<')
    expect(markup).toContain('>Комментарий<')
    expect(markup).toContain('>обязательно<')
    expect(markup).toContain('required=""')
    expect(markup).not.toContain('>PAPER-A4<')
    expect(markup).not.toContain('>paper-a4<')
  })

  it('preserves canonical callbacks while keeping supply quantity out of its renderer payload',()=>{
    const source=readFileSync(new URL('./WorkPage.tsx',import.meta.url),'utf8')
    const writeOffSource=source.slice(source.indexOf('export function WriteOffModal'),source.indexOf('export function SupplyRequestModal'))
    const supplySource=source.slice(source.indexOf('export function SupplyRequestModal'),source.indexOf('export function ReceiveModal'))
    const receiveSource=source.slice(source.indexOf('export function ReceiveModal'))

    expect(source.match(/<PosModal/g)?.length).toBe(3)
    expect(source.match(/onClose={onClose}/g)?.length).toBeGreaterThanOrEqual(3)
    expect(writeOffSource).toContain('onComplete({productId,quantity:Number(quantity),reason,comment:comment.trim()})')
    expect(writeOffSource).toContain('disabled={!productId||Number(quantity)<=0||!comment.trim()}')
    expect(supplySource).toContain('onComplete({productId:productId||undefined,itemName:itemName.trim(),comment:comment.trim()})')
    expect(supplySource).toContain('disabled={!itemName.trim()||!comment.trim()}')
    expect(supplySource).not.toContain('quantity')
    expect(receiveSource).toContain('onComplete(request)')
    expect(receiveSource).toContain('quantity<0||line.quantity>line.remainingQuantity')
    expect(receiveSource).toContain('disabled={invalid||request.lines.length===0}')
  })

  it('reuses the shared modal shell instead of another warehouse modal style',()=>{
    const source=readFileSync(new URL('./WorkPage.tsx',import.meta.url),'utf8')
    const modalSource=readFileSync(new URL('./ui/PosModal.tsx',import.meta.url),'utf8')
    const css=readFileSync(new URL('./workplace.css',import.meta.url),'utf8')

    expect(source).toContain("import { PosModal } from './ui/PosModal'")
    expect(source).toContain("import { PosField } from './ui/PosField'")
    expect(source).not.toContain('modal-backdrop')
    expect(source).not.toContain('payment-modal compact-modal')
    expect(modalSource).toContain('onClick={onClose}')
    expect(css).toContain('.warehouse-modal.pos-modal{width:min(720px,calc(100vw - 32px))}')
    expect(css).toContain('.warehouse-receive-modal.pos-modal{width:min(860px,calc(100vw - 32px))}')
    expect(css).toContain('.receive-lines{max-height:min(46vh,480px);overflow:auto')
  })
})
