import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildCashCountLines, CASH_COUNT_DENOMINATIONS, cashCountTotal, CashCountModal, CashOperationModal, cashierPinNoticeClass, cashierResetEmployeeId, CashierLogin, emptyReceiptDiscountInputs, isCompleteOrderPhone, lockedCashierCanSwitch, NAV_ICON_MAP, Nav, replaceReceiptCustomer, EXPECTED_CASH_LABEL, runLockedCashierSwitch, SettingsNavTrigger, TOAST_DISMISS_MS } from './AppV2'
import { PosButton, PosIconButton } from './ui/PosButton'
import { PosField } from './ui/PosField'
import { PosIcon } from './ui/PosIcon'
import { PosModal } from './ui/PosModal'
import WorkPage, { buildStockReceiptRequest, operationalStockItems, ReceiveModal, warehouseItemMatches, WriteOffModal } from './WorkPage'
import { PinInput } from './PinEntry'
import type { BootState, CashierAuthState, DeliveryNotice, OperationalCatalogItem, WorkplaceData } from '../../shared/contracts'

const boot:BootState={
  pointId:'point',pointName:'Точка',workplaceId:'workplace',workstationName:'Касса',
  cashierName:'Выберите сотрудника',employees:[{id:'e1',name:'Иван Иванов'}],
  accessRevoked:false,online:false,pendingSync:0,source:'demo',shift:null,
  rules:{allowFreePrice:true,allowRemoveCartItem:true,allowDiscounts:true,maxDiscountPercent:100,acceptsCash:true,acceptsCard:true,acceptsQr:true},
  upsellRules:[],upsellCursors:{},
}
const auth:CashierAuthState={status:'signed_out'}
const selectedAuth:CashierAuthState={status:'signed_out',openShiftCashierId:'e1',openShiftCashierName:'Иван Иванов'}

describe('receipt discount input ownership',()=>{
  const firstCustomer={id:'customer-1',name:'Первый клиент',phone:'+7 900 000-00-01',discountPercent:10}
  const replacementCustomer={id:'customer-2',name:'Другой клиент',phone:'+7 900 000-00-02',discountPercent:20}
  const initial={customer:null,reviewCount:1,manualDiscount:{type:'amount' as const,value:1000}}

  it('preserves cashier review and manual inputs on attach, replace and remove customer',()=>{
    const attached=replaceReceiptCustomer(initial,firstCustomer)
    const replaced=replaceReceiptCustomer(attached,replacementCustomer)
    const removed=replaceReceiptCustomer(replaced,null)
    expect(attached).toMatchObject({customer:firstCustomer,reviewCount:1,manualDiscount:{type:'amount',value:1000}})
    expect(replaced).toMatchObject({customer:replacementCustomer,reviewCount:1,manualDiscount:{type:'amount',value:1000}})
    expect(removed).toMatchObject({customer:null,reviewCount:1,manualDiscount:{type:'amount',value:1000}})
  })

  it('resets receipt discount inputs only for explicit clear/new receipt',()=>{
    expect(emptyReceiptDiscountInputs()).toEqual({customer:null,reviewCount:0,manualDiscount:null})
  })
})

describe('cash count contract',()=>{
  it('keeps denomination payload order and exact integer arithmetic',()=>{
    expect(CASH_COUNT_DENOMINATIONS).toEqual([500000,100000,50000,10000,5000,1000,500,200,100])
    const lines=buildCashCountLines({500000:2,1000:3,100:4})
    expect(lines).toEqual([
      {denominationMinor:500000,quantity:2},
      {denominationMinor:100000,quantity:0},
      {denominationMinor:50000,quantity:0},
      {denominationMinor:10000,quantity:0},
      {denominationMinor:5000,quantity:0},
      {denominationMinor:1000,quantity:3},
      {denominationMinor:500,quantity:0},
      {denominationMinor:200,quantity:0},
      {denominationMinor:100,quantity:4},
    ])
    expect(cashCountTotal(lines)).toBe(1003400)
  })
})

describe('cashier workplace micro-contract',()=>{
  const lockedAuth:CashierAuthState={status:'locked',employee:{id:'e1',name:'Иван Иванов'}}
  const lockedOpenShiftAuth:CashierAuthState={...lockedAuth,openShiftCashierId:'e1',openShiftCashierName:'Иван Иванов'}

  it('keeps normal selection calm and PIN as one four-digit form field',()=>{
    const selector=renderToStaticMarkup(<CashierLogin boot={boot} auth={auth} onAuthenticated={async()=>undefined}/>)
    const login=renderToStaticMarkup(<CashierLogin boot={boot} auth={selectedAuth} onAuthenticated={async()=>undefined}/>)
    expect(selector).toContain('Выберите себя')
    expect(selector).not.toContain('КТО РАБОТАЕТ?')
    expect(login).not.toMatch(/>Войти</)
    expect(login).toContain('maxLength="4"')
    expect(login).toContain('pattern="[0-9]{4}"')
    expect(login).toContain('cashier-pin-input')
    expect(login).toContain('pin-input-slots')
    expect((login.match(/class="[^"]*pin-input-slots/g)||[]).length).toBe(1)
    expect((login.match(/class="[^"]*pin-input-control/g)||[]).length).toBe(1)
  })

  it('renders exactly four visual slots while keeping one real PIN input',()=>{
    const markup=renderToStaticMarkup(<PinInput value="12" onChange={()=>undefined} ariaLabel="PIN"/>)
    expect((markup.match(/<input/g)||[]).length).toBe(1)
    expect((markup.match(/pin-input-control/g)||[]).length).toBe(1)
    expect((markup.match(/pin-input-slots/g)||[]).length).toBe(1)
    expect((markup.match(/<span class="/g)||[]).length).toBe(4)
    expect((markup.match(/class="filled"/g)||[]).length).toBe(2)
    expect(markup).toContain('inputMode="numeric"')
    expect(markup).toContain('maxLength="4"')
  })

  it('keeps success green and wrong PIN failures red through explicit notice severity',()=>{
    expect(cashierPinNoticeClass('success')).toBe('cashier-login-notice cashier-login-success')
    expect(cashierPinNoticeClass('error')).toBe('cashier-login-notice cashier-login-error')
  })

  it('routes pre-login and authenticated Settings through the same explicit trigger class',()=>{
    const preLogin=renderToStaticMarkup(<CashierLogin boot={boot} auth={auth} onAuthenticated={async()=>undefined}/>)
    const authenticated=renderToStaticMarkup(<SettingsNavTrigger/>)
    expect(preLogin).toContain('settings-open-trigger')
    expect(authenticated).toContain('settings-open-trigger')
    expect(authenticated).toContain('Настройки')
  })

  it('uses shared centered PIN layout and fixed left/right footer roles',()=>{
    const markup=renderToStaticMarkup(<CashierLogin boot={boot} auth={selectedAuth} onAuthenticated={async()=>undefined}/>)
    expect(markup).toContain('pin-entry-layout')
    expect(markup).toContain('pin-entry-main')
    expect(markup).toContain('pin-entry-content')
    expect(markup).toContain('pin-entry-footer')
    const left=markup.indexOf('pin-entry-footer-left')
    const right=markup.indexOf('pin-entry-footer-right')
    expect(left).toBeGreaterThan(-1)
    expect(right).toBeGreaterThan(left)
    expect(markup.slice(left,right)).toContain('Настройки кассы')
    expect(markup.slice(right)).toContain('Забыли PIN?')
  })

  it('keeps forgot-PIN available while locked and targets the locked employee',()=>{
    const markup=renderToStaticMarkup(<CashierLogin boot={boot} auth={lockedAuth} onAuthenticated={async()=>undefined}/>)
    expect(markup).toContain('Забыли PIN?')
    expect(cashierResetEmployeeId(lockedAuth,'')).toBe('e1')
  })

  it('offers closed-shift cashier hand-off through logout then refresh',async()=>{
    const markup=renderToStaticMarkup(<CashierLogin boot={boot} auth={lockedAuth} onAuthenticated={async()=>undefined}/>)
    expect(lockedCashierCanSwitch(lockedAuth)).toBe(true)
    expect(markup).toMatch(/>Сменить кассира<\//)
    const calls:string[]=[]
    await runLockedCashierSwitch(
      async()=>{calls.push('logout')},
      async()=>{calls.push('refresh')},
    )
    expect(calls).toEqual(['logout','refresh'])
  })

  it('does not offer cashier switching while a work shift is open',()=>{
    const markup=renderToStaticMarkup(<CashierLogin boot={boot} auth={lockedOpenShiftAuth} onAuthenticated={async()=>undefined}/>)
    expect(lockedCashierCanSwitch(lockedOpenShiftAuth)).toBe(false)
    expect(markup).not.toMatch(/>Сменить кассира<\//)
    expect(markup).toContain('разблокируйте текущего кассира и закройте смену')
  })

  it('keeps the toast timeout and shift metric label contract',()=>{
    expect(TOAST_DISMISS_MS).toBe(3000)
    expect(EXPECTED_CASH_LABEL).toBe('Денег в кассе')
  })
})

const workplace:WorkplaceData={
  schedule:[],
  scheduleMonth:{month:'2026-09',days:30,employees:[{id:'e1',name:'Иван Иванов'}],entries:[{id:'entry',date:'2026-09-20',employeeId:'e1',employeeName:'Иван Иванов',shiftTemplate:'Утро',shiftCode:'U',shiftName:'Утренняя',startTime:'09:00:00',endTime:'18:00:00',plannedHours:8}]},
  myUpcomingShifts:[{id:'entry',date:'2026-09-20',shiftTemplate:'Утро',shiftCode:'U',shiftName:'Утренняя',startTime:'09:00:00',endTime:'18:00:00',plannedHours:8}],
  operationalCatalog:[],deliveries:[],supplyRequests:[],cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},orders:[],
}

describe('read-only work schedule contract',()=>{
  it('renders schedule labels without legacy Today or quick actions',()=>{
    const markup=renderToStaticMarkup(<WorkPage products={[]} data={workplace} shiftOpen={false} onChanged={async()=>undefined} notify={()=>undefined}/>)
    expect(markup).toContain('График работы')
    expect(markup).toContain('Мои ближайшие 5 смен')
    expect(markup).toContain('График точки')
    expect(markup).not.toContain('МОЯ СМЕНА СЕГОДНЯ')
    expect(markup).not.toContain('Быстрые действия')
    expect(markup).not.toContain('<select')
    expect(markup).not.toContain('Сохранить')
  })
})


describe('unified warehouse workplace contract',()=>{
  const catalog:OperationalCatalogItem[]=[
    {id:'hidden-paper',name:'Служебная бумага',itemCode:'HIDDEN',itemType:'Product',uom:'пачка',trackInventory:true,stock:7,storageAddress:'Шкаф 2'},
    {id:'service',name:'Ламинация',itemCode:'LAM',itemType:'Service',uom:'шт',trackInventory:false,stock:null,storageAddress:''},
  ]
  const order:DeliveryNotice={
    id:'PO-1',supplier:'Поставщик',status:'Ожидается',items:[
      {purchaseOrderItemId:'POI-1',itemId:'hidden-paper',itemName:'Служебная бумага',itemCode:'HIDDEN',uom:'пачка',orderedQuantity:5,receivedQuantity:1,remainingQuantity:4},
      {purchaseOrderItemId:'POI-2',itemId:'service',itemName:'Ламинация',itemCode:'LAM',uom:'шт',orderedQuantity:1,receivedQuantity:0,remainingQuantity:1},
    ],
  }
  it('keeps only three work tabs and no standalone deliveries tab',()=>{
    const markup=renderToStaticMarkup(<WorkPage products={[]} data={{...workplace,operationalCatalog:catalog,deliveries:[order]}} shiftOpen={false} onChanged={async()=>undefined} notify={()=>undefined}/>)
    expect(markup).toContain('График работы')
    expect(markup).toContain('Товары и склад')
    expect(markup).toContain('Уборка')
    expect(markup).not.toMatch(/<button[^>]*>Поставки<\/button>/)
  })
  it('uses the operational catalog for stock and searches by name id or item code',()=>{
    expect(operationalStockItems(catalog).map((item)=>item.id)).toEqual(['hidden-paper'])
    expect(warehouseItemMatches(catalog[0],'служебная')).toBe(true)
    expect(warehouseItemMatches(catalog[0],'hidden-paper')).toBe(true)
    expect(warehouseItemMatches(catalog[0],'HIDDEN')).toBe(true)
    expect(warehouseItemMatches(catalog[0],'other')).toBe(false)
  })
  it('keeps write-off fields vertical and independent from sale products',()=>{
    const markup=renderToStaticMarkup(<WriteOffModal products={operationalStockItems(catalog)} onClose={()=>undefined} onComplete={async()=>undefined}/>)
    const labels=['>Товар<','>Количество<','>Причина<','>Комментарий<']
    const positions=labels.map((label)=>markup.indexOf(label))
    expect(positions.every((position)=>position>=0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a,b)=>a-b))
    expect(markup).toContain('Служебная бумага')
  })
  it('builds a reduced receipt payload with removed zero rows and no price/header fields',()=>{
    const request=buildStockReceiptRequest('PO-1',[
      {purchaseOrderItemId:'POI-1',itemName:'Служебная бумага',uom:'пачка',remainingQuantity:4,quantity:2},
      {purchaseOrderItemId:'POI-2',itemName:'Ламинация',uom:'шт',remainingQuantity:1,quantity:0},
    ])
    expect(request).toEqual({purchaseOrderId:'PO-1',lines:[{purchaseOrderItemId:'POI-1',quantity:2}]})
    expect(JSON.stringify(request)).not.toMatch(/\"(?:price|rate|itemId|supplier|warehouse)\"\s*:/i)
  })
  it('prefills receive modal from remaining rows and never renders purchase price',()=>{
    const markup=renderToStaticMarkup(<ReceiveModal order={order} onClose={()=>undefined} onComplete={async()=>undefined}/>)
    expect(markup).toContain('Служебная бумага')
    expect(markup).toContain('Осталось по заказу: 4 пачка')
    expect(markup).not.toContain('Цена')
    expect(markup).not.toContain('rate')
  })
})


describe('DEV-169 POS foundation contract',()=>{
  it('maps every shell section to a semantic SVG icon',()=>{
    expect(NAV_ICON_MAP).toEqual({
      sale:'sale',receipts:'receipts',orders:'orders',shift:'shift',work:'work',settings:'settings',
    })
    const markup=renderToStaticMarkup(<Nav active icon={NAV_ICON_MAP.sale} label="Продажа" onClick={()=>undefined}/>)
    expect(markup).toContain('<svg')
    expect(markup).toContain('data-pos-icon="sale"')
    expect(markup).toContain('aria-current="page"')
    expect(markup).not.toContain('▣')
  })

  it('keeps button variants and accessible icon-only labels explicit',()=>{
    const button=renderToStaticMarkup(<PosButton variant="danger" size="touch">Удалить</PosButton>)
    const iconButton=renderToStaticMarkup(<PosIconButton icon="refresh" label="Обновить данные"/>)
    expect(button).toContain('pos-button--danger')
    expect(button).toContain('pos-button--touch')
    expect(iconButton).toContain('aria-label="Обновить данные"')
    expect(iconButton).toContain('title="Обновить данные"')
    expect(iconButton).toContain('data-pos-icon="refresh"')
  })

  it('provides shared modal and field API contracts',()=>{
    const modal=renderToStaticMarkup(<PosModal open title="Проверка" layout="form" onClose={()=>undefined} footer={<PosButton>Готово</PosButton>}><PosField label="Имя" helper="Подсказка"><input/></PosField></PosModal>)
    expect(modal).toContain('role="dialog"')
    expect(modal).toContain('aria-modal="true"')
    expect(modal).toContain('pos-modal--form')
    expect(modal).toContain('pos-field__helper')
    expect(modal).toContain('aria-label="Закрыть"')
  })

  it('renders icons with currentColor and no unicode glyph dependency',()=>{
    const markup=renderToStaticMarkup(<PosIcon name="settings"/>)
    expect(markup).toContain('currentColor')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).not.toContain('⚙')
  })
})


describe('DEV-169 stage 3 operational modal contracts',()=>{
  const appSource=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
  const shiftSource=readFileSync(new URL('./ShiftCloseGuard.tsx',import.meta.url),'utf8')
  const css=readFileSync(new URL('./checkout.css',import.meta.url),'utf8')

  it('blocks clearly incomplete order phones and keeps all required fields',()=>{
    expect(isCompleteOrderPhone('+7 900 000-00-00')).toBe(true)
    expect(isCompleteOrderPhone('90000')).toBe(false)
    expect(isCompleteOrderPhone('+7 900 000-00')).toBe(false)
    expect(appSource).toContain("isCompleteOrderPhone(draft.phone)&&Boolean(draft.comment?.trim())&&Boolean(draft.dueAt)")
    expect(appSource).toContain('title="Оформить заказ"')
    expect(appSource).not.toContain('ОБЯЗАТЕЛЬСТВО КЛИЕНТУ')
    expect(appSource).not.toContain('Заказ появится в работе только после успешной оплаты')
    expect(appSource).toContain('className="order-description-field"')
  })

  it('uses shared modal, field, and button primitives for every mounted inline modal',()=>{
    for(const title of ['Оформить заказ','Возврат по чеку ','Внесение','Выбрать покупателя','Дополнительная скидка','Изменить цену']){
      expect(appSource).toContain(title)
    }
    expect(appSource.match(/<PosModal/g)?.length).toBeGreaterThanOrEqual(7)
    expect(appSource.match(/<PosField/g)?.length).toBeGreaterThanOrEqual(8)
    expect(appSource.match(/<PosButton/g)?.length).toBeGreaterThanOrEqual(8)
  })

  it('preserves cash count denomination order and close-shift interception hooks',()=>{
    expect(CASH_COUNT_DENOMINATIONS).toEqual([500000,100000,50000,10000,5000,1000,500,200,100])
    expect(appSource).toContain('className="cash-count-modal"')
    expect(appSource).toContain('className="denomination-row"')
    expect(appSource).toContain("difference===0?'match':'mismatch'")
    expect(appSource).toContain("type==='closing'?' и закрыть смену':''")
    expect(shiftSource).toContain("button.closest('.cash-count-modal')")
    expect(shiftSource).toContain("querySelector<HTMLElement>('.cash-reconcile .mismatch strong')")
  })

  it('keeps discrepancy recording before the guarded close click',()=>{
    const record=shiftSource.indexOf('recordShiftDiscrepancy(differenceMinor,note.trim())')
    const release=shiftSource.indexOf('allowNext.current=true')
    const click=shiftSource.indexOf('target.current?.click()')
    expect(record).toBeGreaterThan(-1)
    expect(release).toBeGreaterThan(record)
    expect(click).toBeGreaterThan(release)
    expect(shiftSource).toContain('<PosModal')
    expect(shiftSource).toContain('variant="danger"')
  })

  it('keeps modal footers accessible and reflows cash count at short height',()=>{
    expect(css).toContain('@media (max-height:760px)')
    expect(css).toContain('.denominations{display:grid;grid-template-columns:1fr 1fr')
    expect(css).toContain('.cash-count-modal .pos-modal__body')
    expect(css).toContain('.denomination-row{min-height:52px}')
  })
})


describe('DEV-173 stage 3 cash UI',()=>{
  it('keeps expected cash frozen in the opening count and renders the counted total separately',()=>{
    const markup=renderToStaticMarkup(<CashCountModal type="opening" expectedMinor={12345} onClose={()=>undefined} onComplete={async()=>undefined}/>)
    expect(markup).toContain('Ожидается</span><b>123,45 ₽')
    expect(markup).toContain('Насчитано</span><b>0 ₽')
    expect(markup).toContain('Расхождение</span><strong>-123,45 ₽')
    expect(markup).toContain('aria-label="Закрыть"')
    const lines=buildCashCountLines({500:3})
    expect(cashCountTotal(lines)).toBe(1500)
    expect(markup).toContain('Ожидается</span><b>123,45')
  })

  it('marks pending counts on Shift navigation and keeps the reason blank by default',()=>{
    const nav=renderToStaticMarkup(<Nav active={false} icon="shift" label="Смена" warning onClick={()=>undefined}/>)
    expect(nav).toContain('cash-warning')
    expect(nav).toContain('Ожидается пересчёт на начало смены')
    const operation=renderToStaticMarkup(<CashOperationModal type="deposit" onClose={()=>undefined} onComplete={async()=>undefined}/>)
    expect(operation).toContain('Основание')
    expect(operation).not.toContain('placeholder=')
    expect(operation).not.toContain('Без комментария')
  })

  it('routes closing only through a saved count and leaves dismissal pending',()=>{
    const source=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
    expect(source).toContain('saveCashCount(cashCountOpen.type,lines)')
    expect(source).toContain("if(count.countType==='closing'){await closeShift()}")
    expect(source).toContain('onClose={()=>setCashCountOpen(null)}')
    expect(source).toContain("openCashCount(summary.openingCountPending?'opening':'control')")
    expect(source).toContain('expectedMinor:summary.expectedCashMinor')
    expect(source).not.toContain("type==='opening'?total:expectedMinor")
    expect(source).toContain('addCashOperation(cashOperation,amount,reason)')
  })
})
