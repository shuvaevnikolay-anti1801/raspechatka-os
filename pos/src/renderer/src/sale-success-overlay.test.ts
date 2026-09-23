import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PaymentPart } from '../../shared/contracts'
import { paymentSummary } from './SaleSuccessOverlay'

const source=readFileSync(new URL('./SaleSuccessOverlay.tsx',import.meta.url),'utf8')
const css=readFileSync(new URL('./sale-workspace.css',import.meta.url),'utf8')

describe('sale success overlay contract',()=>{
  it('uses the shared POS modal and approved action copy',()=>{
    expect(source).toContain('<PosModal')
    expect(source).toContain('title="Оплата проведена"')
    expect(source).toContain('layout="action"')
    expect(source).toContain('>Вернуться к продаже</PosButton>')
    expect(source).toContain("printing?'Печатаем…':'Напечатать товарный чек'")
    expect(source).not.toMatch(/Спасибо за покупку|ПРОДАЖА ЗАВЕРШЕНА|Фискальный чек сформирован|Новая продажа|подар/i)
  })

  it('shows amount, payment methods, change, receipt number, and date/time',()=>{
    for(const label of ['Сумма','Способ оплаты','Сдача','Номер чека','Дата и время'])expect(source).toContain('<dt>'+label+'</dt>')
    expect(source).toContain('{result.receiptNumber}')
    expect(source).toContain("result.changeMinor?formatMoney(result.changeMinor):'Без сдачи'")
    expect(source).toContain("new Date(createdAt).toLocaleString('ru-RU')")
  })

  it('renders every mixed payment label',()=>{
    const payments:PaymentPart[]=[
      {method:'cash',amountMinor:100},{method:'card',amountMinor:200},
      {method:'qr',amountMinor:300},{method:'remote_payment',amountMinor:400},
    ]
    expect(paymentSummary(payments)).toBe('Наличные + Карта + QR / СБП + Удалённая оплата')
  })

  it('uses canonical getSale createdAt with fallback',()=>{
    expect(source).toContain('const fallbackCreatedAt=new Date().toISOString()')
    expect(source).toContain('window.raspechatkaPos.getSale(saleId)')
    expect(source).toContain('{...current,createdAt:sale.createdAt}')
    expect(source).toContain('.catch(()=>undefined)')
  })

  it('freezes commodity-print behavior and duplicate protection',()=>{
    expect(source).toContain('if(printingRef.current)return')
    expect(source).toContain('printingRef.current=true')
    expect(source).toContain("window.raspechatkaPos.printSale(result.saleId,'commodity')")
    expect(source).not.toContain('completeSale(')
    expect(source).not.toContain("'fiscal-copy'")
    expect(source).toContain('disabled={printing}')
    expect(source).toContain("current?.result.saleId===result.saleId?null:current")
  })

  it('keeps overlay open on print failure with retry copy',()=>{
    const catchBlock=source.slice(source.indexOf('}catch{'),source.indexOf('}finally{'))
    expect(catchBlock).toContain("setPrintError(operatorError(error,'print'))")
    expect(catchBlock).not.toContain('setPayload(null)')
    expect(source).toContain('className="sale-success-print-error" role="alert"')
  })

  it('uses angular shared surfaces and only a semantic check circle',()=>{
    expect(css).toContain('.sale-success-modal{')
    expect(css).toContain('.sale-success-icon{')
    expect(css).toContain('border-radius:50%')
    expect(css).toContain('.sale-success-actions{')
  })
})
