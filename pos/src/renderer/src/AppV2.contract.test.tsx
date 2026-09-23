import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildCashCountLines, CASH_COUNT_DENOMINATIONS, cashCountTotal, CashCountModal, CashOperationModal, saveCountThenClose, cashierPinNoticeClass, cashierResetEmployeeId, CashierLogin, emptyReceiptDiscountInputs, heldUpsellSnapshot, restoreHeldUpsell, isCompleteOrderPhone, lockedCashierCanSwitch, NAV_ICON_MAP, Nav, replaceReceiptCustomer, EXPECTED_CASH_LABEL, runLockedCashierSwitch, SettingsNavTrigger, TOAST_DISMISS_MS } from './AppV2'
import { OrderFormFields, isOrderFormComplete, toOrderFormPayload } from './OrderFormFields'
import { PosButton, PosIconButton } from './ui/PosButton'
import { PosField } from './ui/PosField'
import { PosIcon } from './ui/PosIcon'
import { PosModal } from './ui/PosModal'
import WorkPage, { buildStockReceiptRequest, operationalStockItems, ReceiveModal, warehouseItemMatches, WriteOffModal } from './WorkPage'
import { normalizePinValue, PIN_LENGTH, PinInput } from './PinEntry'
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

describe('held receipt upsell lifecycle',()=>{
  const pending={state:'showing' as const,triggerItem:'base',candidate:{item:'upsell',cashierPhrase:'Предложение'}}

  it('holds and restores the exact pending candidate without rerunning selection',()=>{
    const stored=JSON.parse(JSON.stringify({upsell:heldUpsellSnapshot(pending,null)}))
    expect(stored.upsell).toEqual({state:'pending',triggerItem:'base',candidate:{item:'upsell',cashierPhrase:'Предложение'}})
    expect(restoreHeldUpsell(stored.upsell)).toEqual({cycle:pending,outcome:null})
  })

  it('keeps dismissed proposals resolved across repeated restore',()=>{
    const stored=heldUpsellSnapshot({state:'resolved'},'dismissed')
    expect(stored).toEqual({state:'dismissed'})
    expect(restoreHeldUpsell(stored)).toEqual({cycle:{state:'resolved'},outcome:'dismissed'})
    expect(restoreHeldUpsell(stored)).toEqual(restoreHeldUpsell(stored))
  })

  it('keeps accepted proposals resolved without adding the item again',()=>{
    const stored=heldUpsellSnapshot({state:'resolved'},'accepted')
    expect(stored).toEqual({state:'accepted'})
    const restored=restoreHeldUpsell(stored)
    expect(restored).toEqual({cycle:{state:'resolved'},outcome:'accepted'})
    expect(restoreHeldUpsell(stored)).toEqual(restored)
    expect(restored.cycle.state).not.toBe('eligible')
  })

  it('reads legacy JSON without upsell once as a resolved cycle',()=>{
    const legacy=JSON.parse('{"lines":[{"productId":"base"}]}')
    expect(restoreHeldUpsell(legacy.upsell)).toEqual({cycle:{state:'resolved'},outcome:'dismissed'})
  })

  it('stores lifecycle in the same held receipt request and avoids restore re-add',()=>{
    const source=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
    expect(source).toContain('reviewCount,manualDiscount,upsell:heldUpsellSnapshot(upsellCycle,upsellOutcome)')
    expect(source).toContain('const savedUpsell=restoreHeldUpsell(receipt.upsell)')
    expect(source).toContain('setUpsellCycle(savedUpsell.cycle);setUpsellOutcome(savedUpsell.outcome)')
    expect(source).not.toContain("setUpsellCycle({state:'eligible'})\n    setCart(receipt.lines)")
  })
})

describe('receipt discount input ownership',()=>{
  const firstCustomer={id:'customer-1',name:'Первый клиент',phone:'+7 900 000-00-01',discountPercent:10}
  const replacementCustomer={id:'customer-2',name:'Другой клиент',phone:'+7 900 000-00-02',discountPercent:20}
  const initial={customer:null,reviewCount:1,manualDiscount:{type:'amount' as const,value:1000}}

  it('preserves manual discount and reviews on attach/replace, clears reviews for retail',()=>{
    const attached=replaceReceiptCustomer(initial,firstCustomer)
    const replaced=replaceReceiptCustomer(attached,replacementCustomer)
    const removed=replaceReceiptCustomer(replaced,null)
    expect(attached).toMatchObject({customer:firstCustomer,reviewCount:1,manualDiscount:{type:'amount',value:1000}})
    expect(replaced).toMatchObject({customer:replacementCustomer,reviewCount:1,manualDiscount:{type:'amount',value:1000}})
    expect(removed).toMatchObject({customer:null,reviewCount:0,manualDiscount:{type:'amount',value:1000}})
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

  it('keeps employee selector semantics and callbacks while exposing distinct visual states',()=>{
    const selector=renderToStaticMarkup(<CashierLogin boot={boot} auth={auth} onAuthenticated={async()=>undefined}/>)
    expect(selector).toContain('cashier-employee-card')
    expect(selector).toContain('type="button"')
    expect(selector).toContain('aria-pressed="false"')
    const source=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
    expect(source).toContain('const active=employeeId===employee.id')
    expect(source).toContain('aria-pressed={active}')
    expect(source).toContain('onClick={()=>void choose(employee.id)}')
    expect(source).toContain("auth.status!=='locked'&&!forced")
  })

  it('uses tokenized green idle cards with distinct selected focus and disabled states',()=>{
    const css=readFileSync(new URL('./pos-design-system.css',import.meta.url),'utf8')
    expect(css).toContain('.cashier-login-card .cashier-employee-card{')
    expect(css).toContain('border:1px solid var(--pos-brand)')
    expect(css).toContain('.cashier-login-card .cashier-employee-card:focus-visible{outline:0;box-shadow:var(--pos-focus)}')
    expect(css).toContain('.cashier-login-card .cashier-employee-card.active{border-color:var(--pos-ink);background:var(--pos-brand)')
    expect(css).toContain('.cashier-login-card .cashier-employee-card:disabled{border-color:var(--pos-border);background:var(--pos-canvas);color:var(--pos-muted)')
  })

  it('keeps footer actions in their existing state scenarios with larger tokenized touch targets',()=>{
    const idle=renderToStaticMarkup(<CashierLogin boot={boot} auth={auth} onAuthenticated={async()=>undefined}/>)
    const login=renderToStaticMarkup(<CashierLogin boot={boot} auth={selectedAuth} onAuthenticated={async()=>undefined}/>)
    const locked=renderToStaticMarkup(<CashierLogin boot={boot} auth={lockedAuth} onAuthenticated={async()=>undefined}/>)
    expect(idle).toContain('Настройки кассы')
    expect(idle).not.toContain('Забыли PIN?')
    expect(login).toContain('Настройки кассы')
    expect(login).toContain('Забыли PIN?')
    expect(locked).toContain('Настройки кассы')
    expect(locked).toContain('Забыли PIN?')
    const source=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
    expect(source).toContain('const footerRight=!setup&&!adminReset')
    expect(source).toContain("setAdminReset(true);setPin('');setConfirmation('');setNotice(null)")
    const css=readFileSync(new URL('./pos-design-system.css',import.meta.url),'utf8')
    expect(css).toContain('.cashier-login-card .cashier-forgot-pin,.cashier-login-card .settings-open-trigger{min-height:var(--pos-control-touch);padding-inline:var(--pos-space-4)')
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
    expect(PIN_LENGTH).toBe(4)
  })

  it('keeps digits-only controlled PIN semantics without custom keyboard interception',()=>{
    expect(normalizePinValue('1a2-34x5')).toBe('1234')
    expect(normalizePinValue('аб12')).toBe('12')
    const pinSource=readFileSync(new URL('./PinEntry.tsx',import.meta.url),'utf8')
    expect(pinSource).toContain('value={value}')
    expect(pinSource).toContain('onChange={(event)=>onChange(normalizePinValue(event.target.value))}')
    expect(pinSource).not.toMatch(/onKey(?:Down|Up|Press)=/)
  })

  it('keeps shared PIN touch geometry usable at short renderer heights',()=>{
    const css=readFileSync(new URL('./pos-design-system.css',import.meta.url),'utf8')
    expect(css).toContain('@media (max-height:760px)')
    expect(css).toContain('.pin-input{min-height:calc(var(--pos-control-touch) + var(--pos-space-3))}')
    expect(css).toContain('.pin-input-slots{height:calc(var(--pos-control-touch) + var(--pos-space-3))}')
  })

  it('keeps every cashier auth mode on the shared PinInput and native form submit callbacks',()=>{
    const source=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
    expect(source.match(/<PinInput/g)?.length).toBe(3)
    expect(source).toContain('PinInput autoFocus value={adminCode}')
    expect(source).toContain("PinInput autoFocus={!adminReset} value={pin}")
    expect(source).toContain('PinInput value={confirmation}')
    expect(source).toContain('<form className="cashier-pin-form" onSubmit=')
    expect(source).toContain("if(auth.status==='locked')await window.raspechatkaPos.unlockCashier(pin)")
    expect(source).toContain("else if(setup)await window.raspechatkaPos.createCashierPin(employeeId,pin,confirmation)")
    expect(source).toContain("else await window.raspechatkaPos.loginCashier(employeeId,pin)")
    expect(source).toContain('await window.raspechatkaPos.resetCashierPin(resetEmployeeId,adminCode,pin,confirmation)')
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
  scheduleCurrentMonth:{month:'2026-09',days:30,employees:[{id:'e1',name:'Иван Иванов'}],entries:[{id:'entry',date:'2026-09-20',employeeId:'e1',employeeName:'Иван Иванов',shiftTemplate:'Утро',shiftCode:'U',shiftName:'Утренняя',startTime:'09:00:00',endTime:'18:00:00',plannedHours:8}]},
  scheduleNextMonth:{month:'2026-10',days:31,employees:[],entries:[]},
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
  const orderFormSource=readFileSync(new URL('./OrderFormFields.tsx',import.meta.url),'utf8')
  const ordersSource=readFileSync(new URL('./OrdersPage.tsx',import.meta.url),'utf8')
  const shiftSource=readFileSync(new URL('./ShiftCloseGuard.tsx',import.meta.url),'utf8')
  const css=readFileSync(new URL('./checkout.css',import.meta.url),'utf8')

  it('uses one complete order form contract in Sale create, Orders create and Orders edit',()=>{
    expect(isCompleteOrderPhone('+7 900 000-00-00')).toBe(true)
    expect(isCompleteOrderPhone('90000')).toBe(false)
    expect(isCompleteOrderPhone('+7 900 000-00')).toBe(false)
    const draft={phone:'+7 900 000-00-00',contactMethod:'  Telegram @client  ',dueAt:'2026-09-24T18:30',comment:'  Фотокнига  '}
    expect(isOrderFormComplete(draft)).toBe(true)
    expect(toOrderFormPayload(draft)).toEqual({
      phone:'+7 900 000-00-00',contactMethod:'Telegram @client',dueAt:'2026-09-24T18:30',comment:'Фотокнига',
    })
    const markup=renderToStaticMarkup(<OrderFormFields draft={draft} onChange={()=>undefined}/>)
    const labels=['Телефон *','Способ связи','Дата выдачи *','Описание заказа *']
    const positions=labels.map((label)=>markup.indexOf(label))
    expect(positions.every((position)=>position>=0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a,b)=>a-b))
    expect(markup).not.toContain('Срок готовности')
    expect(orderFormSource).toContain('Введите полный номер из 11 цифр')
    expect(orderFormSource).toContain('className="order-description-field"')
    expect(appSource.match(/<OrderFormFields/g)?.length).toBe(1)
    expect(ordersSource.match(/<OrderFormFields/g)?.length).toBe(2)
    expect(appSource).toContain('order:orderDraft?toOrderFormPayload(orderDraft):undefined')
    expect(ordersSource).toContain('updateOrder({id:order.id,...toOrderFormPayload(draft)})')
    expect(ordersSource).toContain('createOrderFromSale({saleId,...toOrderFormPayload(draft)})')
    expect(appSource).not.toContain('Срок готовности')
    expect(ordersSource).not.toContain('Срок готовности')
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

  it('passes the exact count payload and only closes after a successful closing save',async()=>{
    const events:string[]=[]
    const lines=buildCashCountLines({1000:2})
    const save=async(type:'opening'|'control'|'closing',payload:typeof lines)=>{
      expect(payload).toBe(lines)
      events.push('save:'+type)
      return {id:'count',countType:type,lines:payload,totalMinor:2000,expectedMinor:1000,differenceMinor:1000,createdAt:'2026-09-23'}
    }
    const close=async()=>{events.push('close')}
    await saveCountThenClose('opening',lines,save,close)
    expect(events).toEqual(['save:opening'])
    await saveCountThenClose('closing',lines,save,close)
    expect(events).toEqual(['save:opening','save:closing','close'])
    await expect(saveCountThenClose('closing',lines,async()=>{throw Error('count failed')},close)).rejects.toThrow('count failed')
    expect(events).toEqual(['save:opening','save:closing','close'])
  })

  it('routes closing only through a saved count and leaves dismissal pending',()=>{
    const source=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
    expect(source).toContain('saveCountThenClose(cashCountOpen.type,lines,window.raspechatkaPos.saveCashCount,closeShift)')
    expect(source).toContain("if(count.countType==='closing')await close()")
    expect(source).toContain('onClose={()=>setCashCountOpen(null)}')
    expect(source).toContain("openCashCount(summary.openingCountPending?'opening':'control')")
    expect(source).toContain('expectedMinor:summary.expectedCashMinor')
    expect(source).not.toContain("type==='opening'?total:expectedMinor")
    expect(source).toContain('addCashOperation(cashOperation,amount,reason)')
  })
})


describe('DEV-173 stage 4 shift payment rendering',()=>{
  it('uses configured rules and actual payment breakdown instead of fixed summary fields',()=>{
    const source=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
    expect(source).toContain('shiftPaymentRows(boot.rules,summary.paymentBreakdown??[])')
    expect(source).not.toContain('<dt>Наличные продажи</dt>')
    expect(source).not.toContain('<dt>Удалённая оплата</dt>')
  })
})
