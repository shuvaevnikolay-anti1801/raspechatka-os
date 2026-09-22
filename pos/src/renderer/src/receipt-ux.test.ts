import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const receiptSource=readFileSync(new URL('./CurrentReceipt.tsx',import.meta.url),'utf8')
const appSource=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
const css=readFileSync(new URL('./sale-workspace.css',import.meta.url),'utf8')

describe('current receipt UX contract',()=>{
  it('uses one heading and groups semantic receipt actions in the header',()=>{
    expect(receiptSource).toContain('<h2>Текущая продажа</h2>')
    expect(receiptSource).not.toContain('НОВЫЙ ЧЕК')
    expect(receiptSource.match(/<h2>/g)).toHaveLength(1)
    expect(receiptSource).toContain('className="receipt-quick-actions"')
    expect(receiptSource).toContain('icon="hold"')
    expect(receiptSource).toContain('icon="order"')
    expect(receiptSource).toContain('icon="trash"')
    expect(receiptSource).toContain('onClick={onHold}')
    expect(receiptSource).toContain('onClick={onCreateOrder}')
    expect(receiptSource).toContain('onClick={onClear}')
  })

  it('keeps the final total only on the dominant payment CTA',()=>{
    expect(receiptSource).toContain('К оплате · {formatMoney(totalMinor)}')
    expect(receiptSource.match(/formatMoney\(totalMinor\)/g)).toHaveLength(1)
    expect(receiptSource).toContain('className="pos-v2-pay" variant="primary"')
    expect(receiptSource).not.toContain('className="receipt-actions')
  })

  it('moves customer, reviews, and manual discount into one service-row pattern',()=>{
    expect(receiptSource.match(/className="receipt-service-row/g)).toHaveLength(2)
    expect(receiptSource).toContain('className="receipt-service-row receipt-customer"')
    expect(receiptSource).toContain("className={'receipt-service-row '+")
    expect(receiptSource).toContain('receipt-service-action receipt-manual-discount')
    expect(receiptSource).toContain('onClick={onOpenCustomer}')
    expect(receiptSource).toContain('onClick={onRemoveCustomer}')
    expect(receiptSource).toContain('onClick={onOpenManualDiscount}')
    expect(css).toContain('.receipt-service-block{min-height:0;overflow:auto}')
  })

  it('preserves every discount calculation source',()=>{
    expect(receiptSource).toContain('Скидка клуба {clubPercent}%')
    expect(receiptSource).toContain('<span>Отзывы</span>')
    expect(receiptSource).toContain('<span>Доп. скидка')
    expect(receiptSource).toContain('<span>Без скидок</span><strong>{formatMoney(subtotalMinor)}</strong>')
    expect(receiptSource).toContain('<span>Скидка составила</span><strong>− {formatMoney(totalDiscountMinor)}</strong>')
    expect(appSource).toContain('manualDiscountMinor={breakdown.manualDiscountMinor}')
    expect(appSource).toContain('totalDiscountMinor={breakdown.totalDiscountMinor}')
    expect(appSource).toContain('reviewDiscountMinor={reviewDiscountMinor}')
  })

  it('keeps each line to name plus one integrated calculation/control row',()=>{
    expect(receiptSource).toContain('className="receipt-line-name"')
    expect(receiptSource).toContain('className="receipt-line-meta"')
    expect(receiptSource).toContain('{formatMoney(line.unitPriceMinor)} ×')
    expect(receiptSource).toContain('className="receipt-line-amount"')
    expect(receiptSource).not.toContain('receipt-line-description')
    expect(receiptSource).toContain('min="0.001" step="0.001"')
    expect(receiptSource).toContain("onChange={(event)=>onSetQuantity(line.productId,Number(event.target.value))}")
    expect(receiptSource).toContain("onClick={()=>onChangeQuantity(line.productId,-1)}")
    expect(receiptSource).toContain("onClick={()=>onChangeQuantity(line.productId,1)}")
    expect(receiptSource).toContain("onClick={()=>onOverridePrice(line)}")
  })

  it('keeps upsell phrase primary with separate semantic add and dismiss callbacks',()=>{
    expect(appSource).toContain("cashierPhrase:upsellCycle.candidate.cashierPhrase||'Предложите покупателю: '+activeUpsellProduct.name")
    expect(receiptSource).toContain('className="receipt-upsell-phrase">{upsell.cashierPhrase}</p>')
    expect(receiptSource).toContain('className="receipt-upsell-item"')
    expect(receiptSource).toContain('onClick={onAcceptUpsell}')
    expect(receiptSource).toContain('onClick={onDismissUpsell}')
    expect(receiptSource).toContain('icon="plus"')
    expect(receiptSource).toContain('icon="close"')
    expect(css).toContain('background:var(--pos-brand)')
  })

  it('keeps shift opening and empty-cart guards unchanged',()=>{
    expect(receiptSource).toContain('disabled={!lines.length} onClick={onPay}')
    expect(receiptSource).toContain('onClick={onOpenShift}>Открыть смену</PosButton>')
    expect(receiptSource).toContain('shiftOpen&&<PosIconButton icon="hold"')
    expect(receiptSource).toContain('shiftOpen&&<PosIconButton icon="order"')
  })
})
