import type { CartLine, Customer, ManualDiscount } from '../../shared/contracts'
import { formatMoney } from './money'
import { PosButton, PosIconButton } from './ui/PosButton'
import { PosIcon } from './ui/PosIcon'

type ReceiptUpsell={cashierPhrase:string;name:string;priceMinor:number}
type CurrentReceiptProps={
  lines:readonly CartLine[];customer:Customer|null;clubPercent:number;allowFreePrice:boolean;
  onClear:()=>void;onOpenCustomer:()=>void;onRemoveCustomer:()=>void;onOverridePrice:(line:CartLine)=>void;
  onChangeQuantity:(productId:string,delta:number)=>void;onSetQuantity:(productId:string,quantity:number)=>void;
  upsell:ReceiptUpsell|null;onAcceptUpsell:()=>void;onDismissUpsell:()=>void;allowDiscounts:boolean;
  reviewUnitMinor:number;reviewCount:number;reviewDiscountMinor:number;maxReviews:number;
  onReviewCountChange:(count:number)=>void;manualDiscount:ManualDiscount|null;manualDiscountMinor:number;
  onOpenManualDiscount:()=>void;clubDiscountMinor:number;hasProtectedItems:boolean;subtotalMinor:number;
  totalDiscountMinor:number;roundingAdjustmentMinor:number;totalMinor:number;shiftOpen:boolean;onOpenShift:()=>void;onHold:()=>void;
  onCreateOrder:()=>void;onPay:()=>void
}

export default function CurrentReceipt({
  lines,customer,clubPercent,allowFreePrice,onClear,onOpenCustomer,onRemoveCustomer,
  onOverridePrice,onChangeQuantity,onSetQuantity,upsell,onAcceptUpsell,onDismissUpsell,
  allowDiscounts,reviewUnitMinor,reviewCount,reviewDiscountMinor,maxReviews,onReviewCountChange,
  manualDiscount,manualDiscountMinor,onOpenManualDiscount,clubDiscountMinor,
  hasProtectedItems,subtotalMinor,totalDiscountMinor,roundingAdjustmentMinor,totalMinor,shiftOpen,
  onOpenShift,onHold,onCreateOrder,onPay,
}:CurrentReceiptProps){
  return <aside className="receipt current-receipt">
    <header className="receipt-heading">
      <h2>Текущая продажа</h2>
      <div className="receipt-quick-actions" aria-label="Действия с чеком">
        {shiftOpen&&<PosIconButton icon="hold" variant="quiet" label="Отложить чек" disabled={!lines.length} onClick={onHold}/>}
        {shiftOpen&&<PosIconButton icon="order" variant="quiet" label="Оформить заказ" disabled={!lines.length} onClick={onCreateOrder}/>}
        <PosIconButton icon="trash" variant="quiet" className="receipt-clear" label="Очистить чек" disabled={!lines.length} onClick={onClear}/>
      </div>
    </header>

    <div className="receipt-lines">{!lines.length
      ? <div className="empty"><PosIcon name="plus"/><b>Чек пока пуст</b><span>Выберите услугу или найдите её по названию</span></div>
      : lines.map((line)=><div className="receipt-line current-receipt-line" key={line.productId}>
          <strong className="receipt-line-name">{line.name}</strong>
          <div className="receipt-line-meta">
            <span>{formatMoney(line.unitPriceMinor)} ×</span>
            <div className="qty pos-v2-qty">
              <button aria-label={'Уменьшить количество '+line.name} onClick={()=>onChangeQuantity(line.productId,-1)}>−</button>
              <input aria-label={'Количество '+line.name} type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event)=>onSetQuantity(line.productId,Number(event.target.value))}/>
              <button aria-label={'Увеличить количество '+line.name} onClick={()=>onChangeQuantity(line.productId,1)}>+</button>
            </div>
            <span>=</span>
            <b className="receipt-line-amount">{formatMoney(line.quantity*line.unitPriceMinor)}</b>
            {allowFreePrice&&<button className="receipt-price-override" onClick={()=>onOverridePrice(line)}>Изменить цену</button>}
          </div>
        </div>)}
    </div>

    <div className="receipt-fixed">
    {upsell&&<div className="receipt-upsell">
      <div className="receipt-upsell-copy">
        <small>ПРЕДЛОЖИТЕ ПОКУПАТЕЛЮ</small>
        <p className="receipt-upsell-phrase">{upsell.cashierPhrase}</p>
        <div className="receipt-upsell-item"><strong>{upsell.name}</strong><b>{formatMoney(upsell.priceMinor)}</b></div>
      </div>
      <div className="receipt-upsell-actions">
        <PosIconButton icon="plus" variant="primary" label={'Добавить '+upsell.name} onClick={onAcceptUpsell}/>
        <PosIconButton icon="close" variant="quiet" label="Отклонить рекомендацию" onClick={onDismissUpsell}/>
      </div>
    </div>}

    <footer className="receipt-total current-receipt-footer">
      <div className="receipt-service-block">
      <div className="receipt-service-row receipt-customer">
        <div className="receipt-service-label"><span>Покупатель</span>{customer&&<button className="receipt-service-remove" onClick={onRemoveCustomer}>Убрать</button>}</div>
        <button className="receipt-service-action" onClick={onOpenCustomer}>{customer?.name||'Найти по телефону'}</button>
        <strong>{customer?`${clubPercent}% · − ${formatMoney(clubDiscountMinor)}`:'—'}</strong>
      </div>
      <div className={'receipt-service-row '+(!allowDiscounts?'disabled':'')}>
        <div className="receipt-service-label"><span>Отзывы</span></div>
        <div className="review-count">
          <button disabled={!allowDiscounts||reviewCount<=0} onClick={()=>onReviewCountChange(Math.max(0,reviewCount-1))}>−</button>
          <input aria-label="Количество отзывов" type="number" min="0" max={maxReviews} step="1" value={reviewCount} disabled={!allowDiscounts||reviewUnitMinor<=0} onChange={(event)=>onReviewCountChange(Math.max(0,Math.floor(Number(event.target.value)||0)))}/>
          <button disabled={!allowDiscounts} onClick={()=>onReviewCountChange(reviewCount+1)}>+</button>
        </div>
        <strong>{reviewDiscountMinor?'− '+formatMoney(reviewDiscountMinor):'—'}</strong>
      </div>
      <div className="receipt-service-row">
        <div className="receipt-service-label"><span>Доп. скидка{manualDiscount?.type==='percent'?' '+manualDiscount.value+'%':''}</span></div>
        <button className="receipt-service-action receipt-manual-discount" disabled={!allowDiscounts} onClick={onOpenManualDiscount}>{manualDiscount?'Изменить':'Скидка'}</button>
        <strong>{manualDiscountMinor?'− '+formatMoney(manualDiscountMinor):'—'}</strong>
      </div>
      {hasProtectedItems&&<div className="discount-warning">На отмеченные позиции скидка не применяется.</div>}
      {(totalDiscountMinor>0||roundingAdjustmentMinor>0)&&<>
        <div className="subtotal"><span>Без скидок</span><strong>{formatMoney(subtotalMinor)}</strong></div>
        {roundingAdjustmentMinor>0&&<div className="subtotal"><span>Округление</span><strong>− {formatMoney(roundingAdjustmentMinor)}</strong></div>}
        <div className="subtotal"><span>Скидка составила</span><strong>− {formatMoney(totalDiscountMinor)}</strong></div>
      </>}
      </div>
      {!shiftOpen
        ? <PosButton className="receipt-open-shift" variant="primary" size="touch" onClick={onOpenShift}>Открыть смену</PosButton>
        : <PosButton className="pos-v2-pay" variant="primary" size="touch" disabled={!lines.length||totalMinor<=0} onClick={onPay}>К оплате · {formatMoney(totalMinor)}</PosButton>}
    </footer>
    </div>
  </aside>
}
