import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PaymentPart } from '../../shared/contracts'
import { paymentSummary } from './SaleSuccessOverlay'

const source=readFileSync(new URL('./SaleSuccessOverlay.tsx',import.meta.url),'utf8')
const css=readFileSync(new URL('./pilot-ux.css',import.meta.url),'utf8')

describe('sale success overlay contract',()=>{
  it('uses the exact approved copy and removes legacy promotional/status copy',()=>{
    expect(source).toContain('<h2 id="sale-success-title">Оплата проведена</h2>')
    expect(source).toContain('>Вернуться к продаже</button>')
    expect(source).toContain("printing?'Печатаем…':'Напечатать товарный чек'")
    expect(source).not.toMatch(/Спасибо за покупку|ПРОДАЖА ЗАВЕРШЕНА|Фискальный чек сформирован|По кнопке в «Чеках»|Новая продажа|подар/i)
  })

  it('shows amount, payment methods, change, receipt number, and date/time',()=>{
    expect(source).toContain('<dt>Сумма</dt>')
    expect(source).toContain('<dt>Способ оплаты</dt>')
    expect(source).toContain('<dt>Сдача</dt>')
    expect(source).toContain('<dt>Номер чека</dt>')
    expect(source).toContain('<dt>Дата и время</dt>')
    expect(source).toContain('{result.receiptNumber}')
    expect(source).toContain("result.changeMinor?formatMoney(result.changeMinor):'Без сдачи'")
    expect(source).toContain("new Date(createdAt).toLocaleString('ru-RU')")
  })

  it('renders every mixed payment label from the completed payment parts',()=>{
    const payments:PaymentPart[]=[
      {method:'cash',amountMinor:100},
      {method:'card',amountMinor:200},
      {method:'qr',amountMinor:300},
      {method:'remote_payment',amountMinor:400},
    ]
    expect(paymentSummary(payments)).toBe('Наличные + Карта + QR / СБП + Удалённая оплата')
  })

  it('uses canonical getSale createdAt with a completion-time fallback',()=>{
    expect(source).toContain('const fallbackCreatedAt=new Date().toISOString()')
    expect(source).toContain('createdAt:fallbackCreatedAt')
    expect(source).toContain('window.raspechatkaPos.getSale(saleId)')
    expect(source).toContain('{...current,createdAt:sale.createdAt}')
    expect(source).toContain('.catch(()=>undefined)')
  })

  it('prints a commodity receipt for the same completed sale and never starts a fiscal sale',()=>{
    expect(source).toContain("window.raspechatkaPos.printSale(result.saleId,'commodity')")
    expect(source).not.toContain('completeSale(')
    expect(source).not.toContain("'fiscal-copy'")
  })

  it('keeps the overlay open on print failure and exposes a concise retry state',()=>{
    const catchBlock=source.slice(source.indexOf('}catch{'),source.indexOf('}finally{'))
    expect(catchBlock).toContain("setPrintError('Не удалось напечатать товарный чек. Попробуйте ещё раз.')")
    expect(catchBlock).not.toContain('setPayload(null)')
    expect(source).toContain('{printError&&<div className="sale-success-print-error" role="alert">{printError}</div>}')
  })

  it('blocks duplicate print requests and closes only after successful print',()=>{
    expect(source).toContain('if(printingRef.current)return')
    expect(source).toContain('printingRef.current=true')
    expect(source).toContain('disabled={printing}')
    expect(source).toContain('printingRef.current=false')
    expect(source).toContain("await window.raspechatkaPos.printSale(result.saleId,'commodity')")
    expect(source).toContain("current?.result.saleId===result.saleId?null:current")
  })

  it('keeps structural success surfaces angular while allowing the semantic check circle',()=>{
    const successCss=css.slice(css.indexOf('.sale-success-backdrop'),css.indexOf('.cashier-hotkey-help'))
    expect(successCss).toContain('.sale-success-card{')
    expect(successCss).toContain('border-radius:0')
    expect(successCss).toContain('.sale-success-icon{')
    expect(successCss).toContain('border-radius:50%')
    expect(successCss).toContain('.sale-success-actions button{')
  })
})
