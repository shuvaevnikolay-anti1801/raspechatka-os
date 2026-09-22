import type { CartLine, Customer, ManualDiscount } from '../../shared/contracts'
import { formatMoney } from './money'

type ReceiptUpsell={
  cashierPhrase:string
  name:string
  priceMinor:number
}

type CurrentReceiptProps={
  lines:readonly CartLine[]
  customer:Customer|null
  clubPercent:number
  allowFreePrice:boolean
  onClear:()=>void
  onOpenCustomer:()=>void
  onRemoveCustomer:()=>void
  onOverridePrice:(line:CartLine)=>void
  onChangeQuantity:(productId:string,delta:number)=>void
  onSetQuantity:(productId:string,quantity:number)=>void
  upsell:ReceiptUpsell|null
  onAcceptUpsell:()=>void
  onDismissUpsell:()=>void
  allowDiscounts:boolean
  reviewUnitMinor:number
  reviewCount:number
  reviewDiscountMinor:number
  maxReviews:number
  onReviewCountChange:(count:number)=>void
  manualDiscount:ManualDiscount|null
  manualDiscountMinor:number
  onOpenManualDiscount:()=>void
  clubDiscountMinor:number
  hasProtectedItems:boolean
  subtotalMinor:number
  totalDiscountMinor:number
  totalMinor:number
  shiftOpen:boolean
  onOpenShift:()=>void
  onHold:()=>void
  onCreateOrder:()=>void
  onPay:()=>void
}

export default function CurrentReceipt({
  lines,customer,clubPercent,allowFreePrice,onClear,onOpenCustomer,onRemoveCustomer,
  onOverridePrice,onChangeQuantity,onSetQuantity,upsell,onAcceptUpsell,onDismissUpsell,
  allowDiscounts,reviewUnitMinor,reviewCount,reviewDiscountMinor,maxReviews,onReviewCountChange,
  manualDiscount,manualDiscountMinor,onOpenManualDiscount,clubDiscountMinor,
  hasProtectedItems,subtotalMinor,totalDiscountMinor,totalMinor,shiftOpen,
  onOpenShift,onHold,onCreateOrder,onPay,
}:CurrentReceiptProps){
  return <aside className="receipt current-receipt">
    <header className="receipt-heading">
      <div><small>НОВЫЙ ЧЕК</small><h2>Текущая продажа</h2></div>
      <button className="receipt-clear" aria-label="Очистить чек" title="Очистить чек" disabled={!lines.length} onClick={onClear}><span aria-hidden="true">🗑</span></button>
    </header>

    <div className="customer-row receipt-customer">
      <button onClick={onOpenCustomer}><span aria-hidden="true">◎</span><span>{customer?.name||'Найти покупателя по телефону'}</span></button>
      {customer&&<div><span>Скидка клуба {clubPercent}%</span><button onClick={onRemoveCustomer}>Убрать</button></div>}
    </div>

    <div className="receipt-lines">{!lines.length
      ? <div className="empty"><i>＋</i><b>Чек пока пуст</b><span>Выберите услугу или найдите её по названию</span></div>
      : lines.map((line)=><div className="receipt-line current-receipt-line" key={line.productId}>
          <div className="receipt-line-description">
            <strong>{line.name}</strong>
            <small>{formatMoney(line.unitPriceMinor)} за ед. {allowFreePrice&&<button onClick={()=>onOverridePrice(line)}>Изменить цену</button>}</small>
          </div>
          <div className="qty pos-v2-qty">
            <button aria-label={'Уменьшить количество '+line.name} onClick={()=>onChangeQuantity(line.productId,-1)}>−</button>
            <input aria-label={'Количество '+line.name} type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event)=>onSetQuantity(line.productId,Number(event.target.value))}/>
            <button aria-label={'Увеличить количество '+line.name} onClick={()=>onChangeQuantity(line.productId,1)}>+</button>
          </div>
          <b className="receipt-line-amount">{formatMoney(line.quantity*line.unitPriceMinor)}</b>
        </div>)}
    </div>

    {upsell&&<div className="upsell-card receipt-upsell">
      <div className="receipt-upsell-copy">
        <small>ПРЕДЛОЖИТЕ ПОКУПАТЕЛЮ</small>
        <p className="receipt-upsell-phrase">{upsell.cashierPhrase}</p>
        <div className="receipt-upsell-item"><strong>{upsell.name}</strong><b>{formatMoney(upsell.priceMinor)}</b></div>
      </div>
      <button className="receipt-upsell-add" aria-label={'Добавить '+upsell.name} onClick={onAcceptUpsell}>+</button>
      <button className="receipt-upsell-dismiss" aria-label="Отклонить рекомендацию" onClick={onDismissUpsell}>×</button>
    </div>}

    <footer className="receipt-total current-receipt-footer">
      {clubDiscountMinor>0&&<div className="subtotal"><span>Скидка клуба {clubPercent}%</span><strong>− {formatMoney(clubDiscountMinor)}</strong></div>}
      <div className={'review-discount-row '+(!allowDiscounts?'disabled':'')}>
        <div><span>Отзывы</span><small>{reviewUnitMinor>0?`${formatMoney(reviewUnitMinor)} за отзыв`:'Скидка не настроена'}</small></div>
        <div className="review-count">
          <button disabled={!allowDiscounts||reviewCount<=0} onClick={()=>onReviewCountChange(Math.max(0,reviewCount-1))}>−</button>
          <input aria-label="Количество отзывов" type="number" min="0" max={maxReviews} step="1" value={reviewCount} disabled={!allowDiscounts||reviewUnitMinor<=0} onChange={(event)=>onReviewCountChange(Math.max(0,Math.floor(Number(event.target.value)||0)))}/>
          <button disabled={!allowDiscounts} onClick={()=>onReviewCountChange(reviewCount+1)}>+</button>
        </div>
        <strong>{reviewDiscountMinor?`− ${formatMoney(reviewDiscountMinor)}`:'—'}</strong>
      </div>
      <div className="review-discount-row">
        <div><span>Доп. скидка{manualDiscount?.type==='percent'?` ${manualDiscount.value}%`:''}</span><small>Ограничена настройками точки</small></div>
        <button className="receipt-manual-discount" disabled={!allowDiscounts} onClick={onOpenManualDiscount}>{manualDiscount?'Изменить':'Скидка'}</button>
        <strong>{manualDiscountMinor?`− ${formatMoney(manualDiscountMinor)}`:'—'}</strong>
      </div>
      {hasProtectedItems&&<div className="discount-warning">На отмеченные позиции скидка не применяется.</div>}
      {totalDiscountMinor>0&&<>
        <div className="subtotal"><span>Без скидок</span><strong>{formatMoney(subtotalMinor)}</strong></div>
        <div className="subtotal"><span>Скидка составила</span><strong>− {formatMoney(totalDiscountMinor)}</strong></div>
      </>}
      {!shiftOpen
        ? <button className="primary wide receipt-open-shift" onClick={onOpenShift}>Открыть смену</button>
        : <div className="receipt-actions pos-v2-actions">
            <button disabled={!lines.length} onClick={onHold}>Отложить</button>
            <button disabled={!lines.length} onClick={onCreateOrder}>Оформить заказ</button>
            <button className="primary pos-v2-pay" disabled={!lines.length} onClick={onPay}>К оплате · {formatMoney(totalMinor)}</button>
          </div>}
    </footer>
  </aside>
}
