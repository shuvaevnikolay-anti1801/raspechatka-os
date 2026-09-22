import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source=readFileSync(new URL('./PaymentModalV2.tsx',import.meta.url),'utf8')
const css=readFileSync(new URL('./checkout.css',import.meta.url),'utf8')

describe('payment modal money and device safety',()=>{
  it('preserves exact submit payloads for ordinary, mixed, cash, and remote flows',()=>{
    expect(source).toContain("return onComplete(parts,cashMinor)")
    expect(source).toContain("return onComplete([{method:choice,amountMinor:total}],choice==='cash'?(cashMinor||total):undefined,confirmation)")
    expect(source).toContain("if(mixedRemainder&&rules.acceptsQr)parts.push({method:'qr',amountMinor:mixedRemainder})")
    expect(source).toContain("confirmed:true,confirmedAt:new Date().toISOString(),note:remoteNote.trim()||undefined")
  })

  it('keeps card, QR, and mixed terminal gates tied to real device readiness',()=>{
    expect(source).toContain('window.raspechatkaPos.getDeviceStatuses()')
    expect(source).toContain('setTerminalReady(devices.payment.ready)')
    expect(source).toContain('disabled={busy||!rules.acceptsCard||!terminalReady}')
    expect(source).toContain('disabled={busy||!rules.acceptsQr||!terminalReady}')
    expect(source).toContain('(!terminalChoice||terminalReady)')
    expect(source).toContain('(!mixedUsesTerminal||terminalReady)')
    expect(source).toContain('{terminalMessage}. Деньги не будут считаться принятыми без ответа реального терминала.')
  })

  it('preserves exact cash underpayment and change rules',()=>{
    expect(source).toContain("const cashValid=choice!=='cash'||cashMinor===0||cashMinor>=total")
    expect(source).toContain("cashMinor>0&&cashMinor<total?'Недостаточно':'Сдача'")
    expect(source).toContain('formatMoney(Math.max(0,cashMinor-total))')
    expect(source).toContain('disabled={!canSubmit}')
  })

  it('preserves mixed exact-total, remainder, and non-empty gates',()=>{
    expect(source).toContain('const mixedRemainder=Math.max(0,total-cashMinor-cardMinor)')
    expect(source).toContain('cashMinor+cardMinor+(rules.acceptsQr?mixedRemainder:0)===total')
    expect(source).toContain('cashMinor+cardMinor<=total')
    expect(source).toContain('(cashMinor>0||cardMinor>0||mixedRemainder>0)')
  })

  it('requires explicit remote confirmation and preserves evidence',()=>{
    expect(source).toContain('(!remoteChoice||remoteConfirmed)')
    expect(source).toContain('checked={remoteConfirmed}')
    expect(source).toContain('Я проверил(а), что оплата действительно получена')
    expect(source).toContain('remoteConfirmation?:RemotePaymentConfirmation')
  })

  it('preserves busy, Enter, Escape, textarea, and duplicate-event safety',()=>{
    expect(source).toContain('const canSubmit=!busy&&cashValid&&mixedValid')
    expect(source).toContain("event.key==='Escape'&&!busy")
    expect(source).toContain("event.key==='Enter'&&canSubmit")
    expect(source).toContain("target?.tagName==='TEXTAREA'")
    expect(source).toContain("window.addEventListener('keydown',handler,{capture:true})")
    expect(source).toContain('event.stopImmediatePropagation()')
    expect(source).toContain('closeDisabled={busy}')
    expect(source).toContain("busy?'Операция выполняется…'")
  })
})

describe('payment modal stage 3 presentation',()=>{
  it('uses one shared title, one amount anchor, one CTA, and no permanent keyboard footnote',()=>{
    expect(source).toContain('<PosModal')
    expect(source).toContain('title="Выберите способ оплаты"')
    expect(source.match(/Выберите способ оплаты/g)).toHaveLength(1)
    expect(source).toContain('className="payment-amount-due"')
    expect(source).toContain("'Оплатить · '+formatMoney(total)")
    expect(source).not.toContain('checkout-footnote')
    expect(source).not.toContain('Enter — подтвердить')
  })

  it('renders equal method tiles with explicit active and unavailable states',()=>{
    expect(css).toContain('grid-template-columns:repeat(5,minmax(0,1fr))')
    expect(source).toContain("className={choice==='cash'?'active':''}")
    expect(source).toContain("className={choice==='card'?'active':''}")
    expect(source).toContain("className={choice==='qr'?'active':''}")
    expect(source).toContain('Не принимается')
    expect(source).toContain('Терминал не готов')
  })

  it('renders method details only for the selected method',()=>{
    expect(source).toContain("choice==='cash'&&")
    expect(source).toContain('remoteChoice&&')
    expect(source).toContain("choice==='mixed'&&")
  })

  it('fits ordinary flow through compact short-height rules with fixed critical footer',()=>{
    expect(css).toContain('@media (max-height:760px)')
    expect(css).toContain('.checkout-methods .pos-button{min-height:64px')
    expect(css).toContain('.payment-context{min-height:104px')
    expect(source).toContain('footer={<PosButton className="payment-confirm"')
  })
})
