import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')

describe('receipt UX contract',()=>{
  it('keeps the total only on the payment button and removes the equipment training note',()=>{
    expect(source).toContain('К оплате · {formatMoney(total)}')
    expect(source).not.toContain('<div className="total"><span>Итого</span>')
    expect(source).not.toContain('ККТ и оборудование проверяются перед каждой оплатой')
  })

  it('shows the undiscounted amount without strike-through and a separate discount amount',()=>{
    expect(source).toContain('<span>Без скидок</span><strong>{formatMoney(subtotal)}</strong>')
    expect(source).toContain('<span>Скидка составила</span><strong>− {formatMoney(breakdown.totalDiscountMinor)}</strong>')
    expect(source).not.toContain('<s>{formatMoney(subtotal)}</s>')
  })
})
