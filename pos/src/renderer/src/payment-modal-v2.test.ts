import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source=readFileSync(new URL('./PaymentModalV2.tsx',import.meta.url),'utf8')
const css=readFileSync(new URL('./checkout.css',import.meta.url),'utf8')

describe('PaymentModalV2 safety and visibility contracts',()=>{
  it('shows only the existing methods enabled by point rules',()=>{
    expect(source).toContain("rules.acceptsCash&&<button className={choice==='cash'")
    expect(source).toContain("rules.acceptsCard&&<button className={choice==='card'")
    expect(source).toContain("rules.acceptsQr&&<button className={choice==='qr'")
    expect(source).toContain("rules.acceptsRemotePayment!==false&&<button className={choice==='remote_payment'")
    expect(source).toContain("choice==='mixed'")
    expect(source).toContain('<span>Наличные</span>')
    expect(source).toContain('<span>Карта</span>')
    expect(source).toContain('<span>QR / СБП</span>')
    expect(source).toContain('<span>Удалённая оплата</span>')
    expect(source).toContain('<span>Смешанная</span>')
    expect(source).not.toMatch(/gift|подароч|сертификат/i)
  })

  it('keeps card and QR disabled until the real terminal is ready',()=>{
    expect(source).toContain('window.raspechatkaPos.getDeviceStatuses()')
    expect(source).toContain('setTerminalReady(devices.payment.ready)')
    expect(source).toContain("disabled={busy||!terminalReady}><span>Карта</span>")
    expect(source).toContain("disabled={busy||!terminalReady}><span>QR / СБП</span>")
    expect(source).toContain('(!terminalChoice||terminalReady)')
    expect(source).toContain('(!mixedUsesTerminal||terminalReady)')
    expect(source).toContain('{terminalMessage}. Деньги не будут считаться принятыми без ответа реального терминала.')
  })

  it('blocks cash underpayment and keeps the exact change calculation',()=>{
    expect(source).toContain("const cashValid=choice!=='cash'||cashMinor===0||cashMinor>=total")
    expect(source).toContain("cashMinor>0&&cashMinor<total?'Недостаточно':'Сдача'")
    expect(source).toContain('formatMoney(Math.max(0,cashMinor-total))')
    expect(source).toContain('disabled={!canSubmit}')
  })

  it('requires explicit remote confirmation and preserves its evidence payload',()=>{
    expect(source).toContain("(!remoteChoice||remoteConfirmed)")
    expect(source).toContain('checked={remoteConfirmed}')
    expect(source).toContain('Я проверил(а), что оплата действительно получена')
    expect(source).toContain('confirmed:true,confirmedAt:new Date().toISOString(),note:remoteNote.trim()||undefined')
    expect(source).toContain('remoteConfirmation?:RemotePaymentConfirmation')
    expect(source).toContain('confirmation)')
  })

  it('keeps mixed allocation, exact-total, remainder, and terminal gates',()=>{
    expect(source).toContain('const mixedRemainder=Math.max(0,total-cashMinor-cardMinor)')
    expect(source).toContain('cashMinor+cardMinor+(rules.acceptsQr?mixedRemainder:0)===total')
    expect(source).toContain('cashMinor+cardMinor<=total')
    expect(source).toContain('(!mixedUsesTerminal||terminalReady)')
    expect(source).toContain("if(mixedRemainder&&rules.acceptsQr)parts.push({method:'qr',amountMinor:mixedRemainder})")
    expect(source).toContain('return onComplete(parts,cashMinor)')
  })

  it('uses responsive method tiles and keeps long-flow confirmation reachable',()=>{
    expect(css).toContain('grid-template-columns:repeat(3,minmax(0,1fr))')
    expect(css).toContain('@media(max-width:680px)')
    expect(css).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(css).not.toContain('repeat(5')
    expect(css).toContain('grid-template-columns:minmax(0,1.25fr) minmax(220px,.75fr)')
    expect(css).toContain('@media(max-width:620px)')
    expect(css).toContain('.cash-payment-context{grid-template-columns:1fr}')
    expect(css).toContain('position:sticky')
    expect(source).toContain('className="payment-actions"')
  })

  it('blocks duplicate busy submission and preserves safe keyboard behavior',()=>{
    expect(source).toContain('const canSubmit=!busy&&cashValid&&mixedValid')
    expect(source).toContain("disabled={busy}><span>Наличные</span>")
    expect(source).toContain("busy?'Операция выполняется…'")
    expect(source).toContain("event.key==='Escape'&&!busy")
    expect(source).toContain("event.key==='Enter'&&canSubmit")
    expect(source).toContain("target?.tagName==='TEXTAREA'")
    expect(source).toContain("window.addEventListener('keydown',handler,{capture:true})")
    expect(source).toContain('event.stopImmediatePropagation()')
    expect(source).toContain('После начала операции повторное нажатие блокируется')
    expect(source).toContain('безопасное восстановление')
  })
})
