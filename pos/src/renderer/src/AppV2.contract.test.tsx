import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CashierLogin, EXPECTED_CASH_LABEL, TOAST_DISMISS_MS } from './AppV2'
import type { BootState, CashierAuthState } from '../../shared/contracts'

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
