import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CashierLogin, EXPECTED_CASH_LABEL, TOAST_DISMISS_MS, WorkPage } from './AppV2'
import type { BootState, CashierAuthState, WorkplaceData } from '../../shared/contracts'

const boot:BootState={
  pointId:'point',pointName:'Точка',workplaceId:'workplace',workstationName:'Касса',
  cashierName:'Выберите сотрудника',employees:[{id:'e1',name:'Иван Иванов'}],
  accessRevoked:false,online:false,pendingSync:0,source:'demo',shift:null,
  rules:{allowFreePrice:true,allowRemoveCartItem:true,allowDiscounts:true,maxDiscountPercent:100,acceptsCash:true,acceptsCard:true,acceptsQr:true},
  upsellRules:[],
}
const auth:CashierAuthState={status:'signed_out'}

describe('cashier workplace micro-contract',()=>{
  it('keeps normal selection calm and PIN as one four-digit form field',()=>{
    const markup=renderToStaticMarkup(<CashierLogin boot={boot} auth={auth} onAuthenticated={async()=>undefined}/>)
    expect(markup).toContain('Выберите себя')
    expect(markup).not.toContain('КТО РАБОТАЕТ?')
    expect(markup).not.toMatch(/>Войти</)
    expect(markup).toContain('maxLength="4"')
    expect(markup).toContain('cashier-pin-input')
    expect(markup).toContain('settings-open-trigger')
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
  deliveries:[],supplyRequests:[],cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},orders:[],
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
