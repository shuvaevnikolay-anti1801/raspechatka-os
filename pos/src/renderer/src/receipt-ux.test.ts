import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const receiptSource=readFileSync(new URL('./CurrentReceipt.tsx',import.meta.url),'utf8')
const appSource=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')

describe('current receipt UX contract',()=>{
  it('keeps the final total only on the payment CTA',()=>{
    expect(receiptSource).toContain('К оплате · {formatMoney(totalMinor)}')
    expect(receiptSource.match(/formatMoney\(totalMinor\)/g)).toHaveLength(1)
    expect(receiptSource).not.toContain('<div className="total"><span>Итого</span>')
  })

  it('preserves every existing discount row and its AppV2 calculation source',()=>{
    expect(receiptSource).toContain('Скидка клуба {clubPercent}%')
    expect(receiptSource).toContain('<span>Отзывы</span>')
    expect(receiptSource).toContain('<span>Доп. скидка')
    expect(receiptSource).toContain('<span>Без скидок</span><strong>{formatMoney(subtotalMinor)}</strong>')
    expect(receiptSource).toContain('<span>Скидка составила</span><strong>− {formatMoney(totalDiscountMinor)}</strong>')
    expect(appSource).toContain('manualDiscountMinor={breakdown.manualDiscountMinor}')
    expect(appSource).toContain('totalDiscountMinor={breakdown.totalDiscountMinor}')
    expect(appSource).toContain('reviewDiscountMinor={reviewDiscountMinor}')
    expect(receiptSource).not.toContain('<s>')
  })

  it('keeps the existing upsell phrase with separate add and dismiss actions',()=>{
    expect(appSource).toContain("cashierPhrase:upsellCycle.candidate.cashierPhrase||'Предложите покупателю: '+activeUpsellProduct.name")
    expect(receiptSource).toContain('onClick={onAcceptUpsell}>+</button>')
    expect(receiptSource).toContain('onClick={onDismissUpsell}>×</button>')
    expect(receiptSource).toContain('className="receipt-upsell-phrase">{upsell.cashierPhrase}</p>')
    expect(receiptSource).toContain('className="receipt-upsell-item"')
    expect(receiptSource).toContain("aria-label={'Добавить '+upsell.name}")
    expect(receiptSource).toContain('aria-label="Отклонить рекомендацию"')
  })

  it('keeps every receipt action callback and the intentional manual discount control',()=>{
    for(const callback of [
      'onClick={onClear}',
      'onClick={onOpenCustomer}',
      'onClick={onRemoveCustomer}',
      'onClick={onOpenManualDiscount}',
      'onClick={onHold}',
      'onClick={onCreateOrder}',
      'onClick={onPay}',
      'onClick={onAcceptUpsell}',
      'onClick={onDismissUpsell}',
    ])expect(receiptSource).toContain(callback)
    expect(receiptSource).toContain('className="receipt-manual-discount"')
  })

  it('preserves fractional quantity controls and free-price action',()=>{
    expect(receiptSource).toContain('min="0.001" step="0.001"')
    expect(receiptSource).toContain("onChange={(event)=>onSetQuantity(line.productId,Number(event.target.value))}")
    expect(receiptSource).toContain("onClick={()=>onChangeQuantity(line.productId,-1)}>−</button>")
    expect(receiptSource).toContain("onClick={()=>onChangeQuantity(line.productId,1)}>+</button>")
    expect(receiptSource).toContain('allowFreePrice&&<button onClick={()=>onOverridePrice(line)}>Изменить цену</button>')
  })

  it('uses a factual pre-sale heading without predicting a receipt number',()=>{
    expect(receiptSource).toContain('<small>НОВЫЙ ЧЕК</small><h2>Текущая продажа</h2>')
    expect(receiptSource).not.toContain('receiptNumber')
    expect(receiptSource).not.toMatch(/№\s*\{|Следующий чек|Фискальный чек/)
    expect(receiptSource).toContain('aria-label="Очистить чек" title="Очистить чек" disabled={!lines.length}')
  })

  it('preserves large bottom actions, F4 selector, and empty-cart disabling',()=>{
    expect(receiptSource).toContain('className="receipt-actions pos-v2-actions"')
    expect(receiptSource).toContain('<button disabled={!lines.length} onClick={onHold}>Отложить</button>')
    expect(receiptSource).toContain('<button disabled={!lines.length} onClick={onCreateOrder}>Оформить заказ</button>')
    expect(receiptSource).toContain('className="primary pos-v2-pay" disabled={!lines.length}')
    expect(receiptSource).toContain('onClick={onOpenShift}>Открыть смену</button>')
  })
})
