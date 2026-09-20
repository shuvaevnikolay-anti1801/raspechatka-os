import type { CartLine, Customer, DiscountBreakdown, PointRules, Product } from '../../shared/contracts'
import type { CatalogCategory, CatalogTypeFilter } from './cashier-catalog'

const money=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2})
const formatMoney=(minor:number)=>money.format(minor/100)
const typeLabels:Record<CatalogTypeFilter,string>={all:'Все типы',service:'Услуги',product:'Товары',bundle:'Комплекты'}

type Props={
  products:Product[]
  visibleProducts:Product[]
  categories:CatalogCategory[]
  query:string
  category:string
  productType:CatalogTypeFilter
  cart:CartLine[]
  customer:Customer|null
  rules:PointRules
  breakdown:DiscountBreakdown
  reviewUnitMinor:number
  maxReviews:number
  shiftOpen:boolean
  onQueryChange:(value:string)=>void
  onCategoryChange:(value:string)=>void
  onProductTypeChange:(value:CatalogTypeFilter)=>void
  onAdd:(product:Product)=>void
  onClear:()=>void
  onCustomerOpen:()=>void
  onCustomerRemove:()=>void
  onQuantityChange:(productId:string,value:number)=>void
  onQuantityStep:(productId:string,delta:number)=>void
  onPriceOverride:(line:CartLine)=>void
  onReviewCountChange:(value:number)=>void
  onManualDiscountOpen:()=>void
  onHold:()=>void
  onOrder:()=>void
  onPay:()=>void
  onOpenShift:()=>void
}

export default function CashierSaleWorkspace(props:Props){
  const {
    products,visibleProducts,categories,query,category,productType,cart,customer,rules,breakdown,
    reviewUnitMinor,maxReviews,shiftOpen,onQueryChange,onCategoryChange,onProductTypeChange,onAdd,onClear,
    onCustomerOpen,onCustomerRemove,onQuantityChange,onQuantityStep,onPriceOverride,onReviewCountChange,
    onManualDiscountOpen,onHold,onOrder,onPay,onOpenShift,
  }=props
  const typeFilters=(['all','service','product','bundle'] as CatalogTypeFilter[]).filter((type)=>
    type==='all'||products.some((product)=>product.type===type)
  )
  const quantityByProduct=new Map(cart.map((line)=>[line.productId,line.quantity]))
  const itemCount=cart.reduce((sum,line)=>sum+line.quantity,0)
  const hasProtectedDiscountLine=cart.some((line)=>line.preventDiscounts)

  return <main className="cashier-workspace sale-layout">
    <section className="cashier-catalog catalog">
      <header className="cashier-catalog-head">
        <div><small>КАТАЛОГ</small><h1>Быстрый выбор</h1></div>
        <span>{visibleProducts.length} из {products.length}</span>
      </header>
      <div className="catalog-toolbar cashier-search"><label className="search"><span>⌕</span><input autoFocus value={query} onChange={(event)=>onQueryChange(event.target.value)} placeholder="Название, артикул или штрихкод"/><kbd>F2</kbd>{query&&<button aria-label="Очистить поиск" onClick={()=>onQueryChange('')}>×</button>}</label></div>
      <div className="cashier-type-filters" aria-label="Тип позиции">{typeFilters.map((type)=><button key={type} className={productType===type?'active':''} onClick={()=>onProductTypeChange(type)}>{typeLabels[type]}<span>{type==='all'?products.length:products.filter((product)=>product.type===type).length}</span></button>)}</div>
      <div className="cashier-category-filters" aria-label="Категории">{categories.map((item)=><button key={item.name} className={category===item.name?'active':''} onClick={()=>onCategoryChange(item.name)}><span>{item.name}</span><b>{item.count}</b></button>)}</div>
      <div className="product-grid cashier-product-grid">{visibleProducts.length?visibleProducts.map((product)=>{
        const inCart=quantityByProduct.get(product.id)
        return <button className="product-card pos-v2-product cashier-product-card" key={product.id} onClick={()=>onAdd(product)}>
          <span className="cashier-product-kind">{typeLabels[product.type]}</span>
          {inCart!=null&&<span className="cashier-product-count">{inCart}</span>}
          <strong>{product.name}</strong>
          <small>{product.category} · {product.uom}{product.sku?` · ${product.sku}`:''}</small>
          <footer><b>{formatMoney(product.priceMinor)}</b><span>{product.stock!=null?`Остаток ${product.stock}`:'Добавить'}</span></footer>
        </button>
      }):<div className="cashier-catalog-empty"><b>Ничего не найдено</b><span>Измените запрос или сбросьте фильтры.</span><button onClick={()=>{onQueryChange('');onCategoryChange('Все');onProductTypeChange('all')}}>Показать весь каталог</button></div>}</div>
    </section>

    <aside className="receipt cashier-receipt">
      <header><div><small>ТЕКУЩАЯ ПРОДАЖА</small><h2>{itemCount?`${itemCount} ед. · ${cart.length} поз.`:'Новый чек'}</h2></div><button disabled={!cart.length} onClick={onClear}>Очистить</button></header>
      <div className="customer-row cashier-customer"><button onClick={onCustomerOpen}>◎ <span>{customer?.name||'Добавить покупателя'}</span></button>{customer&&<span>Клуб {breakdown.clubDiscountPercent}% · <button onClick={onCustomerRemove}>убрать</button></span>}</div>
      <div className="receipt-lines cashier-receipt-lines">{!cart.length?<div className="empty"><i>＋</i><b>Чек пока пуст</b><span>Коснитесь товара слева — он сразу появится здесь.</span></div>:cart.map((line)=><article className="receipt-line cashier-receipt-line" key={line.productId}>
        <div className="cashier-line-main"><strong>{line.name}</strong><small>{formatMoney(line.unitPriceMinor)} × {line.quantity} {rules.allowFreePrice&&<button onClick={()=>onPriceOverride(line)}>Изменить цену</button>}</small></div>
        <b className="cashier-line-total">{formatMoney(line.quantity*line.unitPriceMinor)}</b>
        <div className="qty pos-v2-qty cashier-qty"><button aria-label={'Уменьшить '+line.name} onClick={()=>onQuantityStep(line.productId,-1)}>−</button><input aria-label={'Количество '+line.name} type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event)=>onQuantityChange(line.productId,Number(event.target.value))}/><button aria-label={'Увеличить '+line.name} onClick={()=>onQuantityStep(line.productId,1)}>+</button></div>
      </article>)}</div>
      <footer className="receipt-total cashier-totals">
        <div className="cashier-summary-row"><span>Подытог</span><b>{formatMoney(breakdown.subtotalMinor)}</b></div>
        {breakdown.clubDiscountMinor>0&&<div className="cashier-summary-row discount"><span>Клубная скидка {breakdown.clubDiscountPercent}%</span><b>− {formatMoney(breakdown.clubDiscountMinor)}</b></div>}
        <div className={'review-discount-row '+(!rules.allowDiscounts?'disabled':'')}><div><span>Отзывы</span><small>{reviewUnitMinor>0?`${formatMoney(reviewUnitMinor)} за отзыв`:'Скидка не настроена'}</small></div><div className="review-count"><button disabled={!rules.allowDiscounts||breakdown.reviewCount<=0} onClick={()=>onReviewCountChange(Math.max(0,breakdown.reviewCount-1))}>−</button><input aria-label="Количество отзывов" type="number" min="0" max={maxReviews} step="1" value={breakdown.reviewCount} disabled={!rules.allowDiscounts||reviewUnitMinor<=0} onChange={(event)=>onReviewCountChange(Math.max(0,Math.floor(Number(event.target.value)||0)))}/><button disabled={!rules.allowDiscounts} onClick={()=>onReviewCountChange(breakdown.reviewCount+1)}>+</button></div><strong>{breakdown.reviewDiscountMinor?`− ${formatMoney(breakdown.reviewDiscountMinor)}`:'—'}</strong></div>
        <div className="review-discount-row"><div><span>Доп. скидка{breakdown.manualDiscountType==='percent'?` ${breakdown.manualDiscountValue}%`:''}</span><small>По правилам точки</small></div><button disabled={!rules.allowDiscounts} onClick={onManualDiscountOpen}>{breakdown.manualDiscountMinor?'Изменить':'Скидка'}</button><strong>{breakdown.manualDiscountMinor?`− ${formatMoney(breakdown.manualDiscountMinor)}`:'—'}</strong></div>
        {hasProtectedDiscountLine&&<div className="discount-warning">На отмеченные позиции скидка не применяется.</div>}
        <div className="total cashier-grand-total"><span>К оплате</span><strong>{formatMoney(breakdown.totalMinor)}</strong></div>
        {!shiftOpen?<button className="primary wide cashier-open-shift" onClick={onOpenShift}>Открыть смену</button>:<><div className="receipt-actions pos-v2-actions cashier-actions"><button disabled={!cart.length} onClick={onHold}>Отложить</button><button disabled={!cart.length} onClick={onOrder}>Заказ</button><button className="primary pos-v2-pay" disabled={!cart.length} onClick={onPay}>К оплате · {formatMoney(breakdown.totalMinor)}</button></div><small className="training">F4 · перейти к оплате</small></>}
      </footer>
    </aside>
  </main>
}
