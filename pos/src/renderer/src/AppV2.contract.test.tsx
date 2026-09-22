import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildStockReceiptRequest, cashierResetEmployeeId, CashierLogin, emptyReceiptDiscountInputs, lockedCashierCanSwitch, replaceReceiptCustomer, EXPECTED_CASH_LABEL, operationalStockItems, ReceiveModal, runLockedCashierSwitch, SettingsNavTrigger, TOAST_DISMISS_MS, warehouseItemMatches, WorkPage, WriteOffModal } from './AppV2'
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
    const labels=['Товар','Количество','Причина','Комментарий']
    const positions=labels.map((label)=>markup.indexOf('>'+label+'<'))
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
    expect(markup).toContain('Остаток: 4 пачка')
    expect(markup).not.toContain('Цена')
    expect(markup).not.toContain('rate')
  })
})
