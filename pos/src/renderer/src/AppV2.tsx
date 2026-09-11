import { useEffect, useMemo, useState } from 'react'
import { calculateSubtotalMinor, calculateTotalMinor } from '../../shared/cart'
import PaymentModalV2, { type PaymentChoice } from './PaymentModalV2'
import type {
  BootState, CartLine, CashCount, CashCountLine, CashOperation, CashOperationType, ConnectionConfig, ConnectionStatus,
  Customer, HeldReceipt, Order, OrderStatus, PaymentMethod, PaymentPart, PointReceiptSummary, Product,
  RemotePaymentConfirmation, ReturnSummary, SaleDetails, SalePaymentMethod, SaleSummary, ShiftSummary,
  StockWriteOffRequest, SupplyRequestInput, WorkplaceData
} from '../../shared/contracts'

type Screen='sale'|'receipts'|'orders'|'shift'|'work'|'settings'
const money=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2})
const formatMoney=(minor:number)=>money.format(minor/100)
const toMinor=(value:string)=>Math.round((Number(value.replace(',','.'))||0)*100)
const paymentNames:Record<SalePaymentMethod,string>={cash:'Наличные',card:'Карта',qr:'QR / СБП',remote_payment:'Удалённая оплата',mixed:'Смешанная'}
const remotePaymentNames:Record<string,string>={Cash:'Наличные',Card:'Карта',QR:'QR / СБП'}
const emptySummary:ShiftSummary={receipts:0,revenueMinor:0,grossRevenueMinor:0,averageCheckBeforeDiscountMinor:0,returnsMinor:0,cashMinor:0,cardMinor:0,qrMinor:0,remotePaymentMinor:0,depositsMinor:0,withdrawalsMinor:0,expectedCashMinor:0}
const emptyWorkplace:WorkplaceData={schedule:[],deliveries:[],supplyRequests:[],cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},orders:[]}

export default function AppV2(){
  const [boot,setBoot]=useState<BootState|null>(null)
  const [products,setProducts]=useState<Product[]>([])
  const [customers,setCustomers]=useState<Customer[]>([])
  const [sales,setSales]=useState<SaleSummary[]>([])
  const [orders,setOrders]=useState<Order[]>([])
  const [returns,setReturns]=useState<ReturnSummary[]>([])
  const [held,setHeld]=useState<HeldReceipt[]>([])
  const [cashOperations,setCashOperations]=useState<CashOperation[]>([])
  const [summary,setSummary]=useState<ShiftSummary>(emptySummary)
  const [workplace,setWorkplace]=useState<WorkplaceData>(emptyWorkplace)
  const [lastCashCount,setLastCashCount]=useState<CashCount|null>(null)
  const [connection,setConnection]=useState<ConnectionStatus|null>(null)
  const [screen,setScreen]=useState<Screen>('sale')
  const [query,setQuery]=useState('')
  const [category,setCategory]=useState('Все')
  const [cart,setCart]=useState<CartLine[]>([])
  const [customer,setCustomer]=useState<Customer|null>(null)
  const [reviewCount,setReviewCount]=useState(0)
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [payment,setPayment]=useState<PaymentChoice|null>(null)
  const [returnSale,setReturnSale]=useState<SaleDetails|null>(null)
  const [cashOperation,setCashOperation]=useState<CashOperationType|null>(null)
  const [customerOpen,setCustomerOpen]=useState(false)
  const [freePriceOpen,setFreePriceOpen]=useState(false)
  const [cashCountOpen,setCashCountOpen]=useState<CashCount['countType']|null>(null)
  const [orderDraft,setOrderDraft]=useState<{phone:string;comment?:string;dueAt?:string}|null>(null)
  const [receiptQuery,setReceiptQuery]=useState('')
  const [pointReceipts,setPointReceipts]=useState<PointReceiptSummary[]>([])
  const [receiptSearchBusy,setReceiptSearchBusy]=useState(false)
  const [receiptSearchError,setReceiptSearchError]=useState('')

  const refresh=async()=>{
    const result=await Promise.all([
      window.raspechatkaPos.getBootState(),window.raspechatkaPos.listProducts(),
      window.raspechatkaPos.listCustomers(),window.raspechatkaPos.listSales(),
      window.raspechatkaPos.listReturns(),window.raspechatkaPos.listHeldReceipts(),
      window.raspechatkaPos.getShiftSummary(),window.raspechatkaPos.listCashOperations(),
      window.raspechatkaPos.getConnectionStatus(),window.raspechatkaPos.getWorkplaceData(),window.raspechatkaPos.listOrders(),
      window.raspechatkaPos.getLastCashCount()
    ])
    setBoot(result[0]);setProducts(result[1]);setCustomers(result[2]);setSales(result[3])
    setReturns(result[4]);setHeld(result[5]);setSummary(result[6]);setCashOperations(result[7]);setConnection(result[8])
    setWorkplace(result[9]);setOrders(result[10]);setLastCashCount(result[11])
  }
  useEffect(()=>{refresh().catch((e)=>setMessage(String(e)))},[])

  useEffect(()=>{
    if(screen!=='receipts'||!connection?.configured||!boot?.online){
      setPointReceipts([]);setReceiptSearchError('');setReceiptSearchBusy(false);return
    }
    let cancelled=false
    const timer=window.setTimeout(async()=>{
      setReceiptSearchBusy(true);setReceiptSearchError('')
      try{
        const rows=await window.raspechatkaPos.searchPointReceipts(receiptQuery.trim())
        if(!cancelled)setPointReceipts(rows)
      }catch(error){
        if(!cancelled){setPointReceipts([]);setReceiptSearchError(error instanceof Error?error.message:String(error))}
      }finally{if(!cancelled)setReceiptSearchBusy(false)}
    },250)
    return()=>{cancelled=true;window.clearTimeout(timer)}
  },[screen,receiptQuery,connection?.configured,boot?.online])

  const categories=useMemo(()=>['Все',...new Set(products.map((p)=>p.category))],[products])
  const visible=useMemo(()=>{
    const text=query.trim().toLocaleLowerCase('ru')
    return products.filter((p)=>(category==='Все'||p.category===category)&&(!text||(p.name+' '+p.sku+' '+(p.barcode||'')).toLocaleLowerCase('ru').includes(text)))
  },[products,query,category])
  const productById=useMemo(()=>new Map(products.map((p)=>[p.id,p])),[products])
  const subtotal=calculateSubtotalMinor(cart)
  const discountBlocked=cart.some((line)=>productById.get(line.productId)?.preventDiscounts)
  const discountAllowed=Boolean(boot?.rules.allowDiscounts)&&!discountBlocked
  const clubPercent=discountAllowed&&customer?.isClubMember?Math.min(customer.discountPercent,boot?.rules.maxDiscountPercent??0):0
  const clubTotal=calculateTotalMinor(cart,clubPercent)
  const minimumAllowedTotal=discountAllowed?calculateTotalMinor(cart,boot?.rules.maxDiscountPercent??0):subtotal
  const reviewUnitMinor=discountAllowed?(boot?.rules.reviewDiscountPerReviewMinor??0):0
  const reviewBudgetMinor=Math.max(0,clubTotal-minimumAllowedTotal)
  const maxReviews=reviewUnitMinor>0?Math.floor(reviewBudgetMinor/reviewUnitMinor):0
  const safeReviewCount=Math.min(reviewCount,maxReviews)
  const reviewDiscountMinor=Math.min(reviewBudgetMinor,safeReviewCount*reviewUnitMinor)
  const clubDiscountMinor=Math.max(0,subtotal-clubTotal)
  const total=Math.max(0,clubTotal-reviewDiscountMinor)
  const effectiveDiscountPercent=subtotal>0?Math.max(0,Math.min(boot?.rules.maxDiscountPercent??100,(subtotal-total)/subtotal*100)):0
  const preferredPayment:PaymentChoice=boot?.rules.acceptsCash?'cash':boot?.rules.acceptsRemotePayment!==false?'remote_payment':boot?.rules.acceptsCard?'card':'qr'

  useEffect(()=>{if(reviewCount>maxReviews)setReviewCount(maxReviews)},[maxReviews,reviewCount])

  const add=(product:Product)=>setCart((current)=>{
    const found=current.find((line)=>line.productId===product.id)
    return found?current.map((line)=>line.productId===product.id?{...line,quantity:line.quantity+1}:line):[...current,{productId:product.id,name:product.name,quantity:1,unitPriceMinor:product.priceMinor}]
  })
  const setQuantity=(id:string,value:number)=>setCart((current)=>current.map((line)=>line.productId===id?{...line,quantity:Math.max(0,Math.round(value*1000)/1000)}:line).filter((line)=>line.quantity>0))
  const change=(id:string,delta:number)=>setCart((current)=>current.map((line)=>line.productId===id?{...line,quantity:Math.round((line.quantity+delta)*1000)/1000}:line).filter((line)=>line.quantity>0))
  const clear=()=>{setCart([]);setCustomer(null);setReviewCount(0);setOrderDraft(null)}
  const openShift=async()=>{try{await window.raspechatkaPos.openShift();await refresh();setCashCountOpen('opening');setMessage('Смена открыта — пересчитайте стартовые наличные')}catch(e){setMessage(e instanceof Error?e.message:String(e))}}
  const closeShift=async()=>{const x=await window.raspechatkaPos.closeShift();await refresh();setMessage('Смена закрыта: '+x.receipts+' чеков, итог '+formatMoney(x.revenueMinor-x.returnsMinor))}
  const holdReceipt=async()=>{
    if(!cart.length)return
    await window.raspechatkaPos.holdReceipt({label:customer?.name||'Чек на '+formatMoney(total),lines:cart,customer,discountPercent:effectiveDiscountPercent})
    clear();await refresh();setMessage('Чек отложен')
  }
  const restoreReceipt=async(receipt:HeldReceipt)=>{
    setCart(receipt.lines);setCustomer(receipt.customer??null);setReviewCount(0)
    await window.raspechatkaPos.deleteHeldReceipt(receipt.id);await refresh();setScreen('sale')
  }
  const complete=async(payments:PaymentPart[],cashReceivedMinor?:number,remotePaymentConfirmation?:RemotePaymentConfirmation)=>{
    if(busy)return
    setBusy(true)
    try{
      const result=await window.raspechatkaPos.completeSale({
        clientRequestId:crypto.randomUUID(),payments,lines:cart,customer,
        receiptDiscountPercent:effectiveDiscountPercent,cashReceivedMinor,remotePaymentConfirmation,order:orderDraft||undefined
      })
      clear();setPayment(null);await refresh()
      const baseMessage=orderDraft?'Заказ '+(result.order?.orderNumber||'создан')+' принят':'Чек '+result.receiptNumber+' готов'+(result.changeMinor?'. Сдача: '+formatMoney(result.changeMinor):'')
      setMessage(result.commodityPrintWarning?baseMessage+'. Товарный чек ожидает повторной печати: '+result.commodityPrintWarning:baseMessage)
    }catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  const startReturn=async(sale:SaleSummary)=>{
    if(!boot?.shift){setMessage('Для возврата сначала откройте смену');return}
    try{setReturnSale(await window.raspechatkaPos.getSale(sale.id))}catch(e){setMessage(String(e))}
  }
  const chooseCustomer=(value:Customer|null)=>{setCustomer(value);setReviewCount(0);setCustomerOpen(false)}
  const printSale=async(id:string,kind:'fiscal-copy'|'commodity')=>{
    try{const result=await window.raspechatkaPos.printSale(id,kind);setMessage(result.message)}
    catch(e){setMessage(e instanceof Error?e.message:String(e))}
  }

  const localFilteredSales=useMemo(()=>{
    const text=receiptQuery.trim().toLocaleLowerCase('ru')
    if(!text)return sales
    return sales.filter((sale)=>(sale.receiptNumber+' '+(sale.customerName||'')).toLocaleLowerCase('ru').includes(text))
  },[sales,receiptQuery])

  if(!boot)return <div className="loading"><i/>Запускаем кассу…</div>
  return <div className="app-shell">
    <header className="topbar pos-v2-topbar">
      <div className="point pos-v2-point"><b>{boot.pointName}</b></div>
      <div className="top-status"><span className={boot.online?'online':'offline'}><i/>{boot.online?'OS на связи':'Локальный режим'}</span><button onClick={()=>setScreen('settings')}>{boot.cashierName}</button></div>
    </header>
    <nav className="main-nav">
      <Nav active={screen==='sale'} icon="▣" label="Продажа" onClick={()=>setScreen('sale')}/>
      <Nav active={screen==='receipts'} icon="⌁" label="Чеки" badge={held.length} onClick={()=>setScreen('receipts')}/>
      <Nav active={screen==='orders'} icon="▤" label="Заказы" badge={orders.filter((x)=>!['issued','cancelled'].includes(x.status)).length} onClick={()=>setScreen('orders')}/>
      <Nav active={screen==='shift'} icon="◷" label="Смена" onClick={()=>setScreen('shift')}/>
      <Nav active={screen==='work'} icon="▦" label="Работа" onClick={()=>setScreen('work')}/>
      <Nav active={screen==='settings'} icon="⚙" label="Настройки" onClick={()=>setScreen('settings')}/>
      <div className="nav-spacer"/><span className="sync-state">К отправке: <b>{boot.pendingSync}</b></span>
    </nav>
    {message&&<div className="toast" onClick={()=>setMessage('')}>{message}<button>×</button></div>}

    {screen==='sale'&&<main className="sale-layout">
      <aside className="categories"><strong>Категории</strong>{categories.map((name)=><button key={name} className={category===name?'active':''} onClick={()=>setCategory(name)}>{name}<span>{name==='Все'?products.length:products.filter((p)=>p.category===name).length}</span></button>)}</aside>
      <section className="catalog">
        <div className="catalog-toolbar"><label className="search"><span>⌕</span><input autoFocus value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Товар, услуга, артикул или штрихкод"/><kbd>F2</kbd></label>{boot.rules.allowFreePrice&&<button className="secondary" onClick={()=>setFreePriceOpen(true)}>Свободная цена</button>}</div>
        <div className="product-grid">{visible.map((p)=><button className="product-card pos-v2-product" key={p.id} onClick={()=>add(p)}><strong>{p.name}</strong><footer><b>{formatMoney(p.priceMinor)}</b>{p.stock!=null&&<span>Остаток {p.stock}</span>}</footer></button>)}</div>
      </section>
      <aside className="receipt">
        <header><div><small>ТЕКУЩАЯ ПРОДАЖА</small></div><button disabled={!cart.length} onClick={clear}>Очистить</button></header>
        <div className="customer-row"><button onClick={()=>setCustomerOpen(true)}>◎ {customer?.name||'Найти покупателя по телефону'}</button>{customer&&<span>{customer.isClubMember?`Участник клуба · −${customer.discountPercent}%`:(customer.clubStatus||'Без скидки')} · <button onClick={()=>chooseCustomer(null)}>убрать</button></span>}</div>
        <div className="receipt-lines">{!cart.length?<div className="empty"><i>＋</i><b>Чек пока пуст</b><span>Выберите услугу или найдите её по названию</span></div>:cart.map((line)=><div className="receipt-line" key={line.productId}>
          <div><strong>{line.name}</strong><small>{formatMoney(line.unitPriceMinor)} за ед.</small></div>
          <div className="qty pos-v2-qty"><button onClick={()=>change(line.productId,-1)}>−</button><input aria-label={'Количество '+line.name} type="number" min="0.001" step="0.001" value={line.quantity} onChange={(e)=>setQuantity(line.productId,Number(e.target.value))}/><button onClick={()=>change(line.productId,1)}>+</button></div>
          <b>{formatMoney(line.quantity*line.unitPriceMinor)}</b>
        </div>)}</div>
        <footer className="receipt-total">
          {clubDiscountMinor>0&&<div className="subtotal"><span>Скидка клуба {clubPercent}%</span><strong>− {formatMoney(clubDiscountMinor)}</strong></div>}
          <div className={'review-discount-row '+(!discountAllowed?'disabled':'')}><div><span>Отзывы</span><small>{reviewUnitMinor>0?`${formatMoney(reviewUnitMinor)} за отзыв`:'Скидка не настроена'}</small></div><div className="review-count"><button disabled={!discountAllowed||safeReviewCount<=0} onClick={()=>setReviewCount(Math.max(0,safeReviewCount-1))}>−</button><input type="number" min="0" max={maxReviews} step="1" value={safeReviewCount} disabled={!discountAllowed||reviewUnitMinor<=0} onChange={(e)=>setReviewCount(Math.min(maxReviews,Math.max(0,Math.floor(Number(e.target.value)||0))))}/><button disabled={!discountAllowed||safeReviewCount>=maxReviews} onClick={()=>setReviewCount(Math.min(maxReviews,safeReviewCount+1))}>+</button></div><strong>{reviewDiscountMinor?`− ${formatMoney(reviewDiscountMinor)}`:'—'}</strong></div>
          {discountBlocked&&<div className="discount-warning">В чеке есть позиция, для которой скидки запрещены.</div>}
          {(clubDiscountMinor>0||reviewDiscountMinor>0)&&<div className="subtotal"><span>Без скидок</span><s>{formatMoney(subtotal)}</s></div>}
          <div className="total"><span>Итого</span><strong>{formatMoney(total)}</strong></div>
          {!boot.shift?<button className="primary wide" onClick={openShift}>Открыть смену</button>:<>
            <div className="receipt-actions pos-v2-actions"><button disabled={!cart.length} onClick={holdReceipt}>Отложить</button><button disabled={!cart.length} onClick={()=>setOrderDraft({phone:customer?.phone||'',comment:''})}>Оформить заказ</button><button className="primary pos-v2-pay" disabled={!cart.length} onClick={()=>setPayment(preferredPayment)}>К оплате · {formatMoney(total)}</button></div>
            <small className="training">ККТ и оборудование проверяются перед каждой оплатой</small>
          </>}
        </footer>
      </aside>
    </main>}

    {screen==='receipts'&&<Page title="Чеки и возвраты" kicker="">
      <div className="receipt-search"><label><span>⌕</span><input autoFocus value={receiptQuery} onChange={(e)=>setReceiptQuery(e.target.value)} placeholder="Номер чека, телефон, клиент или товар"/></label><div><b>История текущей точки</b><small>{boot.online?'Поиск по Распечатка OS':'Локально: текущая касса'}</small></div></div>
      {receiptSearchError&&<div className="error-note">История OS недоступна: {receiptSearchError}. Показаны локальные чеки.</div>}
      {held.length>0&&<section className="held"><h3>Отложенные</h3>{held.map((r)=><article key={r.id}><div><b>{r.label}</b><small>{r.lines.length} поз. · {new Date(r.createdAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</small></div><button onClick={()=>restoreReceipt(r)}>Продолжить</button></article>)}</section>}
      {boot.online&&!receiptSearchError?<PointReceiptTable rows={pointReceipts} loading={receiptSearchBusy} localSales={sales} shiftOpen={Boolean(boot.shift)} onPrint={printSale} onReturn={startReturn}/>:<LocalReceiptTable rows={localFilteredSales} onPrint={printSale} onReturn={startReturn}/>} 
      {returns.length>0&&<section className="return-history"><h3>Оформленные возвраты этой кассы</h3>{returns.map((x)=><article key={x.id}><div><b>{x.receiptNumber}</b><small>к чеку {x.originalReceiptNumber} · {new Date(x.createdAt).toLocaleString('ru-RU')}</small></div><strong>− {formatMoney(x.totalMinor)}</strong></article>)}</section>}
    </Page>}

    {screen==='orders'&&<OrdersPage orders={orders} onChanged={refresh} notify={setMessage}/>} 
    {screen==='shift'&&<Page title="Текущая смена" kicker="">
      <div className="metrics pos-v2-metrics"><Metric label="Продажи" value={formatMoney(summary.revenueMinor)}/><Metric label="Средний чек без скидок" value={formatMoney(summary.averageCheckBeforeDiscountMinor??0)}/><Metric label="Возвраты" value={'− '+formatMoney(summary.returnsMinor)}/><Metric label="В кассе ожидается" value={formatMoney(summary.expectedCashMinor)}/><Metric label="Чеков" value={String(summary.receipts)}/></div>
      <section className="shift-card"><div><small>КАССИР</small><h2>{boot.cashierName}</h2><p>{boot.shift?'Начало: '+new Date(boot.shift.openedAt).toLocaleString('ru-RU'):'Откройте смену, чтобы проводить продажи'}</p>{lastCashCount&&<small>Последний пересчёт: {formatMoney(lastCashCount.totalMinor)} · расхождение {formatMoney(lastCashCount.differenceMinor)}</small>}</div>{boot.shift?<div className="shift-actions"><button onClick={()=>setCashCountOpen('control')}>Пересчитать кассу</button><button onClick={()=>setCashOperation('deposit')}>Внести деньги</button><button onClick={()=>setCashOperation('withdrawal')}>Изъять деньги</button><button className="danger" onClick={()=>setCashCountOpen('closing')}>Закрыть смену</button></div>:<button className="primary" onClick={openShift}>Открыть смену</button>}</section>
      {boot.shift&&<div className="shift-details"><section><h3>Оплаты</h3><dl><div><dt>Наличные продажи</dt><dd>{formatMoney(summary.cashMinor)}</dd></div><div><dt>Карта</dt><dd>{formatMoney(summary.cardMinor)}</dd></div><div><dt>QR / СБП</dt><dd>{formatMoney(summary.qrMinor)}</dd></div><div><dt>Удалённая оплата</dt><dd>{formatMoney(summary.remotePaymentMinor??0)}</dd></div><div><dt>Внесения</dt><dd>{formatMoney(summary.depositsMinor)}</dd></div><div><dt>Изъятия</dt><dd>− {formatMoney(summary.withdrawalsMinor)}</dd></div></dl></section><section><h3>Движения наличных</h3>{cashOperations.length?cashOperations.map((x)=><article key={x.id}><div><b>{x.type==='deposit'?'Внесение':'Изъятие'}</b><small>{x.reason} · {new Date(x.createdAt).toLocaleTimeString('ru-RU')}</small></div><strong>{x.type==='deposit'?'+':'−'} {formatMoney(x.amountMinor)}</strong></article>):<p>Операций пока нет</p>}</section></div>}
    </Page>}
    {screen==='work'&&<WorkPage products={products} data={workplace} shiftOpen={Boolean(boot.shift)} onChanged={refresh} notify={setMessage}/>} 
    {screen==='settings'&&<Settings boot={boot} connection={connection} onSaved={refresh} onSynced={async()=>{await refresh();setMessage('Каталог, настройки и очередь операций синхронизированы')}}/>}

    {payment&&<PaymentModalV2 choice={payment} total={total} rules={boot.rules} busy={busy} onChoice={setPayment} onClose={()=>setPayment(null)} onComplete={complete}/>}
    {orderDraft&&<OrderModal draft={orderDraft} total={total} onClose={()=>setOrderDraft(null)} onPay={()=>setPayment(preferredPayment)} onSave={async(d)=>{try{const o=await window.raspechatkaPos.createUnpaidOrder({phone:d.phone,lines:cart,comment:d.comment,dueAt:d.dueAt});setOrderDraft(null);clear();await refresh();setMessage('Заказ '+o.orderNumber+' сохранён без оплаты')}catch(e){setMessage(e instanceof Error?e.message:String(e))}}}/>} 
    {returnSale&&<ReturnModal sale={returnSale} busy={busy} onClose={()=>setReturnSale(null)} onComplete={async(lines,payments)=>{setBusy(true);try{const x=await window.raspechatkaPos.createReturn({clientRequestId:crypto.randomUUID(),saleId:returnSale.id,lines,payments});setReturnSale(null);await refresh();setMessage('Возврат '+x.receiptNumber+' оформлен на '+formatMoney(x.totalMinor))}catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}}/>} 
    {cashOperation&&<CashOperationModal type={cashOperation} onClose={()=>setCashOperation(null)} onComplete={async(amount,reason)=>{try{await window.raspechatkaPos.addCashOperation(cashOperation,amount,reason);setCashOperation(null);await refresh();setMessage('Операция с наличными сохранена')}catch(e){setMessage(String(e))}}}/>} 
    {customerOpen&&<CustomerModal customers={customers} selected={customer} onClose={()=>setCustomerOpen(false)} onSelect={chooseCustomer}/>} 
    {freePriceOpen&&<FreePriceModal onClose={()=>setFreePriceOpen(false)} onAdd={(name,price)=>{setCart((current)=>[...current,{productId:'free-'+crypto.randomUUID(),name,quantity:1,unitPriceMinor:price}]);setFreePriceOpen(false)}}/>}
    {cashCountOpen&&<CashCountModal type={cashCountOpen} expectedMinor={summary.expectedCashMinor} onClose={()=>setCashCountOpen(null)} onComplete={async(lines)=>{try{const count=await window.raspechatkaPos.saveCashCount(cashCountOpen,lines);setCashCountOpen(null);await refresh();if(count.countType==='closing'){await closeShift()}else setMessage('Пересчёт сохранён. Расхождение: '+formatMoney(count.differenceMinor))}catch(e){setMessage(e instanceof Error?e.message:String(e))}}}/>} 
  </div>
}

function PointReceiptTable({rows,loading,localSales,shiftOpen,onPrint,onReturn}:{rows:PointReceiptSummary[];loading:boolean;localSales:SaleSummary[];shiftOpen:boolean;onPrint:(id:string,kind:'fiscal-copy'|'commodity')=>Promise<void>;onReturn:(sale:SaleSummary)=>Promise<void>}){
  const localById=new Map(localSales.map((sale)=>[sale.id,sale]))
  return <div className="data-table receipts-table pos-v2-history"><header><span>Чек</span><span>Дата</span><span>Покупатель</span><span>Оплата</span><span>Сумма</span><span/></header>{loading?<Empty title="Ищем чеки" text="Запрашиваем историю этой точки в Распечатка OS."/>:rows.length?rows.map((row)=>{const local=row.externalId?localById.get(row.externalId):undefined;return <div key={row.id}><b>{row.receiptNumber}{row.reviewDiscountMinor>0&&<small>Отзывы: − {formatMoney(row.reviewDiscountMinor)}</small>}</b><span>{new Date(row.createdAt).toLocaleString('ru-RU')}</span><span>{row.customerName}<small>{row.customerPhone||''}{row.cashierName?` · ${row.cashierName}`:''}</small></span><span>{row.paymentLabel.split(' + ').map((x)=>remotePaymentNames[x]||x).join(' + ')}</span><strong>{formatMoney(row.totalMinor)}{row.discountMinor>0&&<small>скидка {formatMoney(row.discountMinor)}</small>}</strong><div className="sale-actions">{local?<><button onClick={()=>onPrint(local.id,'fiscal-copy')}>Копия чека</button><button onClick={()=>onPrint(local.id,'commodity')}>Товарный</button><button disabled={!shiftOpen||local.status==='returned'} onClick={()=>onReturn(local)}>Возврат</button></>:<span className="history-readonly">История OS</span>}</div></div>}):<Empty title="Чеки не найдены" text="Измените запрос или очистите строку поиска."/>}</div>
}

function LocalReceiptTable({rows,onPrint,onReturn}:{rows:SaleSummary[];onPrint:(id:string,kind:'fiscal-copy'|'commodity')=>Promise<void>;onReturn:(sale:SaleSummary)=>Promise<void>}){
  return <div className="data-table receipts-table"><header><span>Чек</span><span>Дата</span><span>Покупатель</span><span>Оплата</span><span>Сумма</span><span/></header>{rows.length?rows.map((s)=><div key={s.id}><b>{s.receiptNumber}<small className={'sale-status '+s.status}>{s.status==='returned'?'Возвращён':s.status==='partially_returned'?'Частичный возврат':''}</small></b><span>{new Date(s.createdAt).toLocaleString('ru-RU')}</span><span>{s.customerName||'Розничный покупатель'}</span><span>{paymentNames[s.paymentMethod]||s.paymentMethod}</span><strong>{formatMoney(s.totalMinor)}{s.returnedMinor>0&&<small>− {formatMoney(s.returnedMinor)}</small>}</strong><div className="sale-actions"><button onClick={()=>onPrint(s.id,'fiscal-copy')}>Копия чека</button><button onClick={()=>onPrint(s.id,'commodity')}>Товарный</button><button disabled={s.status==='returned'} onClick={()=>onReturn(s)}>Возврат</button></div></div>):<Empty title="Чеки не найдены" text="На этой кассе подходящих чеков нет."/>}</div>
}

function OrderModal({draft,total,onClose,onPay,onSave}:{draft:{phone:string;comment?:string;dueAt?:string};total:number;onClose:()=>void;onPay:()=>void;onSave:(draft:{phone:string;comment?:string;dueAt?:string})=>Promise<void>}){
  const [phone,setPhone]=useState(draft.phone);const [comment,setComment]=useState(draft.comment||'');const [dueAt,setDueAt]=useState(draft.dueAt||'')
  const value={phone,comment,dueAt:dueAt||undefined}
  return <div className="modal-backdrop"><div className="payment-modal compact-modal"><header><div><small>ОБЯЗАТЕЛЬСТВО КЛИЕНТУ</small><h2>Оформить заказ</h2></div><button onClick={onClose}>×</button></header><p>Сумма: <b>{formatMoney(total)}</b>. Заказ не меняет остатки — он попадёт в очередь выполнения.</p><label className="cash-input"><span>Телефон *</span><input autoFocus value={phone} onChange={(e)=>setPhone(e.target.value)} placeholder="+7 900 000-00-00"/></label><label className="cash-input"><span>Комментарий</span><textarea value={comment} onChange={(e)=>setComment(e.target.value)} placeholder="Что изготовить или выдать"/></label><label className="cash-input"><span>Готовность (необязательно)</span><input type="datetime-local" value={dueAt} onChange={(e)=>setDueAt(e.target.value)}/></label><button className="primary confirm" disabled={phone.replace(/\D/g,'').length<5} onClick={()=>onSave(value)}>Сохранить без оплаты</button><button className="confirm" disabled={phone.replace(/\D/g,'').length<5} onClick={onPay}>Сохранить и принять оплату · {formatMoney(total)}</button></div></div>
}

function OrdersPage({orders,onChanged,notify}:{orders:Order[];onChanged:()=>Promise<void>;notify:(text:string)=>void}){
  const [editing,setEditing]=useState<Order|null>(null)
  const update=async(id:string,status:OrderStatus)=>{try{await window.raspechatkaPos.updateOrder({id,status});await onChanged();notify('Статус заказа обновлён')}catch(e){notify(e instanceof Error?e.message:String(e))}}
  return <Page title="Заказы" kicker=""><p className="orders-note">Заказ оформляется на кассе и отображается здесь как журнал выполнения. Остатки и складские движения меняются только при фактической продаже.</p><div className="orders-list">{orders.length?orders.map((o)=><article className="order-card" key={o.id}><header><div><small>{o.orderNumber}</small><h2>{o.phone}</h2><span>{o.customerName||'Покупатель не выбран'} · {new Date(o.createdAt).toLocaleString('ru-RU')}</span></div><b className={'order-status '+o.status}>{({new:'Новый',in_progress:'В работе',ready:'Готов',issued:'Выдан',cancelled:'Отменён'} as Record<string,string>)[o.status]}</b></header><div className="order-meta"><strong>{formatMoney(o.totalMinor)}</strong><span>{o.paymentStatus==='paid'?'Оплачено':o.paymentStatus==='partial'?'Частично оплачено':'Не оплачено'}</span>{o.dueAt&&<span>до {new Date(o.dueAt).toLocaleString('ru-RU')}</span>}</div>{o.comment&&<p>{o.comment}</p>}<footer><button onClick={()=>setEditing(o)}>Изменить</button><button onClick={()=>update(o.id,'in_progress')}>В работу</button><button onClick={()=>update(o.id,'ready')}>Готов</button><button onClick={()=>update(o.id,'issued')}>Выдан</button></footer></article>):<Empty title="Заказов пока нет" text="Оформите заказ из текущего чека — он появится здесь."/>}</div>{editing&&<EditOrderModal order={editing} onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);await onChanged();notify('Заказ сохранён')}}/>}</Page>
}

function EditOrderModal({order,onClose,onSaved}:{order:Order;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [phone,setPhone]=useState(order.phone);const [comment,setComment]=useState(order.comment||'');const [status,setStatus]=useState<OrderStatus>(order.status);const [dueAt,setDueAt]=useState(order.dueAt||'')
  return <div className="modal-backdrop"><div className="payment-modal compact-modal"><header><div><small>{order.orderNumber}</small><h2>Изменить заказ</h2></div><button onClick={onClose}>×</button></header><label className="cash-input"><span>Телефон</span><input value={phone} onChange={(e)=>setPhone(e.target.value)}/></label><label className="cash-input"><span>Комментарий</span><textarea value={comment} onChange={(e)=>setComment(e.target.value)}/></label><label className="cash-input"><span>Статус</span><select value={status} onChange={(e)=>setStatus(e.target.value as OrderStatus)}><option value="new">Новый</option><option value="in_progress">В работе</option><option value="ready">Готов</option><option value="issued">Выдан</option><option value="cancelled">Отменён</option></select></label><label className="cash-input"><span>Срок готовности</span><input type="datetime-local" value={dueAt} onChange={(e)=>setDueAt(e.target.value)}/></label><button className="primary confirm" disabled={phone.replace(/\D/g,'').length<5} onClick={async()=>{await window.raspechatkaPos.updateOrder({id:order.id,phone,comment,status,dueAt:dueAt||undefined});await onSaved()}}>Сохранить</button></div></div>
}

function ReturnModal({sale,busy,onClose,onComplete}:{sale:SaleDetails;busy:boolean;onClose:()=>void;onComplete:(lines:Array<{saleItemId:number;quantity:number}>,payments:PaymentPart[])=>Promise<void>}){
  const [quantities,setQuantities]=useState<Record<number,number>>({})
  const [method,setMethod]=useState<PaymentMethod>(sale.payments[0]?.method??'cash')
  const raw=sale.lines.reduce((sum,x)=>sum+Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent??0)/100)),0)||1
  const total=sale.lines.reduce((sum,x)=>{const paid=Math.round(sale.totalMinor*Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent??0)/100))/raw);return sum+Math.round(paid*(quantities[x.id]??0)/x.quantity)},0)
  const lines=Object.entries(quantities).filter(([,q])=>q>0).map(([id,quantity])=>({saleItemId:Number(id),quantity}))
  return <div className="modal-backdrop"><div className="payment-modal return-modal"><header><div><small>ВОЗВРАТ ПО ЧЕКУ</small><h2>{sale.receiptNumber}</h2></div><button onClick={onClose}>×</button></header><div className="return-lines">{sale.lines.map((x)=>{const available=x.quantity-x.returnedQuantity;return <article key={x.id}><div><b>{x.name}</b><small>Куплено {x.quantity}, ранее возвращено {x.returnedQuantity}</small></div><label>Вернуть <input type="number" min="0" max={available} step="1" value={quantities[x.id]??0} onChange={(e)=>setQuantities({...quantities,[x.id]:Math.min(available,Math.max(0,Number(e.target.value)))})}/></label></article>})}</div><div className="refund-footer"><div><span>Вернуть клиенту</span><strong>{formatMoney(total)}</strong></div><label>Способ возврата<select value={method} onChange={(e)=>setMethod(e.target.value as PaymentMethod)}>{sale.payments.map((x)=><option key={x.method} value={x.method}>{paymentNames[x.method]||x.method}</option>)}</select></label></div>{method==='remote_payment'&&<div className="error-note">Автоматический возврат удалённой оплаты пока не подключён. Выберите другой согласованный способ возврата.</div>}<button className="primary confirm" disabled={busy||!lines.length||!total||method==='remote_payment'} onClick={()=>onComplete(lines,[{method,amountMinor:total}])}>{busy?'Оформляем…':'Оформить возврат · '+formatMoney(total)}</button></div></div>
}

function CashOperationModal({type,onClose,onComplete}:{type:CashOperationType;onClose:()=>void;onComplete:(amount:number,reason:string)=>Promise<void>}){
  const [amount,setAmount]=useState('');const [reason,setReason]=useState('')
  return <div className="modal-backdrop"><div className="payment-modal compact-modal"><header><div><small>ДЕНЕЖНЫЙ ЯЩИК</small><h2>{type==='deposit'?'Внесение':'Изъятие'}</h2></div><button onClick={onClose}>×</button></header><label className="cash-input"><span>Сумма</span><input autoFocus value={amount} onChange={(e)=>setAmount(e.target.value)}/></label><label className="cash-input"><span>Основание</span><input value={reason} onChange={(e)=>setReason(e.target.value)} placeholder={type==='deposit'?'Размен в начале смены':'Инкассация'}/></label><button className="primary confirm" disabled={toMinor(amount)<=0} onClick={()=>onComplete(toMinor(amount),reason)}>{type==='deposit'?'Внести':'Изъять'} · {formatMoney(toMinor(amount))}</button></div></div>
}

function CustomerModal({customers,selected,onClose,onSelect}:{customers:Customer[];selected:Customer|null;onClose:()=>void;onSelect:(value:Customer|null)=>void}){
  const [query,setQuery]=useState('')
  const normalized=query.replace(/\D/g,'')
  const visible=customers.filter((x)=>!query||(x.name+' '+(x.phone||'')).toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))||(normalized&&(x.phone||'').replace(/\D/g,'').includes(normalized))).slice(0,50)
  return <div className="modal-backdrop"><div className="payment-modal customer-modal"><header><div><small>БАЗА КЛИЕНТОВ OS</small><h2>Выбрать покупателя</h2></div><button onClick={onClose}>×</button></header><label className="customer-search"><span>⌕</span><input autoFocus value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Введите телефон или имя"/></label><div className="customer-list"><button className={!selected?'active':''} onClick={()=>onSelect(null)}><div><b>Розничный покупатель</b><small>Без персональной скидки</small></div></button>{visible.map((x)=><button key={x.id} className={selected?.id===x.id?'active':''} onClick={()=>onSelect(x)}><div><b>{x.name}</b><small>{x.phone||'Телефон не указан'} · {x.purchaseCount||0} покупок</small></div>{x.isClubMember?<strong className="club-badge">Клуб · −{x.discountPercent}%</strong>:<span className="club-status">{x.clubStatus||'Не в клубе'}</span>}</button>)}</div></div></div>
}

function FreePriceModal({onClose,onAdd}:{onClose:()=>void;onAdd:(name:string,price:number)=>void}){
  const [name,setName]=useState('Свободная позиция');const [price,setPrice]=useState('')
  return <div className="modal-backdrop"><div className="payment-modal compact-modal"><header><div><small>РУЧНАЯ ПОЗИЦИЯ</small><h2>Свободная цена</h2></div><button onClick={onClose}>×</button></header><label className="cash-input"><span>Наименование</span><input value={name} onChange={(e)=>setName(e.target.value)}/></label><label className="cash-input"><span>Цена</span><input autoFocus value={price} onChange={(e)=>setPrice(e.target.value)} placeholder="0,00"/></label><button className="primary confirm" disabled={!name.trim()||toMinor(price)<=0} onClick={()=>onAdd(name.trim(),toMinor(price))}>Добавить · {formatMoney(toMinor(price))}</button></div></div>
}

function WorkPage({products,data,shiftOpen,onChanged,notify}:{products:Product[];data:WorkplaceData;shiftOpen:boolean;onChanged:()=>Promise<void>;notify:(text:string)=>void}){
  const [tab,setTab]=useState<'today'|'stock'|'delivery'|'cleaner'>('today')
  const [writeOff,setWriteOff]=useState(false);const [need,setNeed]=useState(false)
  const today=new Date().toISOString().slice(0,10);const todayShift=data.schedule.find((x)=>x.date===today);const stockProducts=products.filter((x)=>x.trackInventory)
  return <Page title="Рабочее место" kicker=""><div className="work-tabs"><button className={tab==='today'?'active':''} onClick={()=>setTab('today')}>Сегодня</button><button className={tab==='stock'?'active':''} onClick={()=>setTab('stock')}>Товары и склад</button><button className={tab==='delivery'?'active':''} onClick={()=>setTab('delivery')}>Поставки</button><button className={tab==='cleaner'?'active':''} onClick={()=>setTab('cleaner')}>Уборка{data.cleaner.paymentDueMinor>0&&<b>!</b>}</button></div>
    {tab==='today'&&<div className="work-grid"><section className="work-card hero-card"><small>МОЯ СМЕНА СЕГОДНЯ</small>{todayShift?<><h2>{todayShift.shiftName}</h2><strong>{todayShift.startTime.slice(0,5)}–{todayShift.endTime.slice(0,5)}</strong><p>План: {todayShift.plannedHours} ч.</p></>:<><h2>В графике нет смены</h2><p>Если это ошибка, сообщите старшему менеджеру.</p></>}</section><section className="work-card"><h3>Ближайшие смены</h3>{data.schedule.length?data.schedule.slice(0,7).map((x)=><article key={x.id}><div><b>{new Date(x.date+'T00:00:00').toLocaleDateString('ru-RU',{weekday:'short',day:'numeric',month:'short'})}</b><small>{x.shiftName}</small></div><strong>{x.startTime.slice(0,5)}–{x.endTime.slice(0,5)}</strong></article>):<p>Опубликованный график пока не загружен.</p>}</section><section className="work-card quick-card"><h3>Быстрые действия</h3><button onClick={()=>{setTab('stock');setWriteOff(true)}}>Списать брак</button><button onClick={()=>{setTab('stock');setNeed(true)}}>Сообщить, что заканчивается</button><button onClick={()=>setTab('delivery')}>Посмотреть поставки</button></section></div>}
    {tab==='stock'&&<><div className="work-toolbar"><div><h2>Остатки и хранение</h2><p>Адрес относится к товару на этой конкретной точке.</p></div><button onClick={()=>setWriteOff(true)}>Списать брак</button><button className="primary" onClick={()=>setNeed(true)}>Потребность точки</button></div><div className="stock-list"><header><span>Товар</span><span>Остаток</span><span>Где лежит</span></header>{stockProducts.map((x)=><div key={x.id}><div><b>{x.name}</b><small>{x.sku}</small></div><strong className={(x.stock??0)<=0?'low':''}>{x.stock??0} {x.uom}</strong><span>{x.storageAddress||'Адрес ещё не указан'}</span></div>)}</div>{data.supplyRequests.length>0&&<section className="work-card open-needs"><h3>Уже отправлено закупщику</h3>{data.supplyRequests.map((x)=><article key={x.id}><div><b>{x.itemName}</b><small>{x.comment||new Date(x.createdAt).toLocaleDateString('ru-RU')}</small></div><span>{x.quantity} · {x.status}</span></article>)}</section>}</>}
    {tab==='delivery'&&<section className="work-card delivery-list"><h2>Ожидаемые поставки</h2><p>Только то, что нужно сотруднику для приёмки. Сам складской документ оформляется в OS.</p>{data.deliveries.length?data.deliveries.map((x)=><article key={x.id}><div><small>{x.expectedDate?new Date(x.expectedDate+'T00:00:00').toLocaleDateString('ru-RU'):'Дата не назначена'}</small><h3>{x.supplier}</h3><p>{x.details||'Без дополнительной информации'}</p></div><div><span>{x.status}</span>{x.deliveryCode&&<strong>Код: {x.deliveryCode}</strong>}</div></article>):<Empty title="Поставок нет" text="Новые ожидаемые поставки появятся здесь из OS."/>}</section>}
    {tab==='cleaner'&&<div className="work-grid"><section className="work-card hero-card"><small>УБОРОК ДО ВЫПЛАТЫ</small><h2>{Math.min(data.cleaner.visitsSincePayment,4)} из 4</h2><p>Каждое посещение отмечается один раз.</p><button className="primary" onClick={async()=>{try{const r=await window.raspechatkaPos.recordCleanerVisit();await onChanged();notify(r.paymentDueMinor?'Четыре уборки отмечены — можно выплатить 2 000 ₽':'Посещение уборщицы отмечено')}catch(e){notify(String(e))}}}>Отметить сегодняшнюю уборку</button>{data.cleaner.paymentDueMinor>0&&<button className="pay-cleaner" disabled={!shiftOpen} onClick={async()=>{try{await window.raspechatkaPos.payCleaner(data.cleaner.paymentDueMinor);await onChanged();notify('Выплата уборщице проведена как изъятие из кассы')}catch(e){notify(e instanceof Error?e.message:String(e))}}}>Выплатить {formatMoney(data.cleaner.paymentDueMinor)} из кассы</button>}</section><section className="work-card"><h3>Последние посещения</h3>{data.cleaner.recentVisits.length?data.cleaner.recentVisits.map((x)=><article key={x.id}><div><b>{new Date(x.visitDate+'T00:00:00').toLocaleDateString('ru-RU')}</b><small>{x.recordedBy}</small></div><span>{x.paid?'Оплачено':'Ожидает'}</span></article>):<p>Посещений пока нет</p>}</section></div>}
    {writeOff&&<WriteOffModal products={stockProducts} onClose={()=>setWriteOff(false)} onComplete={async(request)=>{try{await window.raspechatkaPos.reportStockWriteOff(request);setWriteOff(false);await onChanged();notify('Списание поставлено в очередь и уйдёт в OS при синхронизации')}catch(e){notify(e instanceof Error?e.message:String(e))}}}/>} 
    {need&&<SupplyRequestModal products={products} onClose={()=>setNeed(false)} onComplete={async(request)=>{try{await window.raspechatkaPos.createSupplyRequest(request);setNeed(false);await onChanged();notify('Потребность точки отправлена закупщику')}catch(e){notify(e instanceof Error?e.message:String(e))}}}/>} 
  </Page>
}

function WriteOffModal({products,onClose,onComplete}:{products:Product[];onClose:()=>void;onComplete:(request:StockWriteOffRequest)=>Promise<void>}){
  const [productId,setProductId]=useState(products[0]?.id||'');const [quantity,setQuantity]=useState('1');const [reason,setReason]=useState<StockWriteOffRequest['reason']>('Брак');const [comment,setComment]=useState('')
  return <div className="modal-backdrop"><div className="payment-modal compact-modal"><header><div><small>СКЛАД ТОЧКИ</small><h2>Списать товар</h2></div><button onClick={onClose}>×</button></header><label className="cash-input"><span>Товар</span><select value={productId} onChange={(e)=>setProductId(e.target.value)}>{products.map((x)=><option key={x.id} value={x.id}>{x.name} · остаток {x.stock??0}</option>)}</select></label><div className="form-row"><label className="cash-input"><span>Количество</span><input type="number" min="0.001" step="0.001" value={quantity} onChange={(e)=>setQuantity(e.target.value)}/></label><label className="cash-input"><span>Причина</span><select value={reason} onChange={(e)=>setReason(e.target.value as StockWriteOffRequest['reason'])}><option>Брак</option><option>Внутренние нужды</option><option>Обучение</option><option>Другое</option></select></label></div><label className="cash-input"><span>Комментарий</span><input value={comment} onChange={(e)=>setComment(e.target.value)} placeholder="Что произошло — коротко"/></label><button className="primary confirm" disabled={!productId||Number(quantity)<=0} onClick={()=>onComplete({productId,quantity:Number(quantity),reason,comment})}>Подтвердить списание</button></div></div>
}

function SupplyRequestModal({products,onClose,onComplete}:{products:Product[];onClose:()=>void;onComplete:(request:SupplyRequestInput)=>Promise<void>}){
  const [productId,setProductId]=useState('');const [itemName,setItemName]=useState('');const [quantity,setQuantity]=useState('1');const [comment,setComment]=useState('')
  const select=(id:string)=>{setProductId(id);setItemName(products.find((x)=>x.id===id)?.name||'')}
  return <div className="modal-backdrop"><div className="payment-modal compact-modal"><header><div><small>ПОТРЕБНОСТЬ ТОЧКИ</small><h2>Что нужно заказать</h2></div><button onClick={onClose}>×</button></header><label className="cash-input"><span>Из каталога (необязательно)</span><select value={productId} onChange={(e)=>select(e.target.value)}><option value="">Другая позиция</option>{products.map((x)=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label className="cash-input"><span>Наименование</span><input value={itemName} onChange={(e)=>setItemName(e.target.value)} placeholder="Например: бумага А4"/></label><label className="cash-input"><span>Количество</span><input type="number" min="0.001" step="0.001" value={quantity} onChange={(e)=>setQuantity(e.target.value)}/></label><label className="cash-input"><span>Комментарий</span><input value={comment} onChange={(e)=>setComment(e.target.value)} placeholder="Срочность или уточнение"/></label><button className="primary confirm" disabled={!itemName.trim()||Number(quantity)<=0} onClick={()=>onComplete({productId:productId||undefined,itemName:itemName.trim(),quantity:Number(quantity),comment})}>Отправить закупщику</button></div></div>
}

function CashCountModal({type,expectedMinor,onClose,onComplete}:{type:CashCount['countType'];expectedMinor:number;onClose:()=>void;onComplete:(lines:CashCountLine[])=>Promise<void>}){
  const denominations=[500000,100000,50000,10000,5000,1000,500,200,100];const [quantities,setQuantities]=useState<Record<number,number>>({});const lines=denominations.map((denominationMinor)=>({denominationMinor,quantity:quantities[denominationMinor]||0}));const total=lines.reduce((sum,x)=>sum+x.denominationMinor*x.quantity,0);const expected=type==='opening'?total:expectedMinor
  return <div className="modal-backdrop"><div className="payment-modal cash-count-modal"><header><div><small>ПЕРЕСЧЁТ НАЛИЧНЫХ</small><h2>{type==='opening'?'Наличные на начало смены':type==='closing'?'Перед закрытием смены':'Контроль кассы'}</h2></div><button onClick={onClose}>×</button></header><div className="denominations">{denominations.map((x)=><label key={x}><span>{formatMoney(x)}</span><input type="number" min="0" step="1" value={quantities[x]||''} onChange={(e)=>setQuantities({...quantities,[x]:Math.max(0,Math.floor(Number(e.target.value)||0))})}/><b>{formatMoney(x*(quantities[x]||0))}</b></label>)}</div><div className="cash-reconcile"><div><span>{type==='opening'?'Стартовый остаток':'Ожидается'}</span><b>{formatMoney(expected)}</b></div><div><span>Посчитано</span><b>{formatMoney(total)}</b></div><div className={total-expected===0?'match':'mismatch'}><span>Расхождение</span><strong>{formatMoney(total-expected)}</strong></div></div><button className="primary confirm" onClick={()=>onComplete(lines)}>Сохранить пересчёт{type==='closing'?' и закрыть смену':''}</button></div></div>
}

function Nav({active,icon,label,badge,onClick}:{active:boolean;icon:string;label:string;badge?:number;onClick:()=>void}){return <button className={active?'active':''} onClick={onClick}><i>{icon}</i>{label}{badge?<b>{badge}</b>:null}</button>}
function Page({title,children}:{title:string;kicker:string;children:React.ReactNode}){return <main className="page"><div className="page-heading"><div><h1>{title}</h1></div></div>{children}</main>}
function Metric({label,value}:{label:string;value:string}){return <article><small>{label}</small><strong>{value}</strong></article>}
function Empty({title,text}:{title:string;text:string}){return <div className="page-empty"><i>＋</i><b>{title}</b><span>{text}</span></div>}

function Settings({boot,connection,onSaved,onSynced}:{boot:BootState;connection:ConnectionStatus|null;onSaved:()=>Promise<void>;onSynced:()=>Promise<void>}){
  const [form,setForm]=useState<ConnectionConfig>({serverUrl:connection?.serverUrl||'https://os.rpechatka.ru',apiKey:'',apiSecret:'',workplaceCode:connection?.workplaceCode||''});const [status,setStatus]=useState('')
  const save=async()=>{try{await window.raspechatkaPos.saveConnection(form);await onSaved();setStatus('Подключение сохранено в защищённом хранилище Windows')}catch(e){setStatus(String(e))}}
  const sync=async()=>{try{setStatus('Отправляем операции и обновляем каталог…');await window.raspechatkaPos.syncNow();await onSynced();setStatus('Синхронизация завершена')}catch(e){setStatus(e instanceof Error?e.message:String(e))}}
  return <Page title="Настройки кассы" kicker=""><div className="settings-grid"><section className="settings-card"><h2>Распечатка OS</h2><p>Касса получает сотрудника, точку, ассортимент и цены, а продажи и возвраты отправляет обратно.</p><label>Адрес OS<input value={form.serverUrl} onChange={(e)=>setForm({...form,serverUrl:e.target.value})}/></label><div className="form-row"><label>API key<input value={form.apiKey} onChange={(e)=>setForm({...form,apiKey:e.target.value})}/></label><label>API secret<input type="password" value={form.apiSecret} onChange={(e)=>setForm({...form,apiSecret:e.target.value})}/></label></div><label>Код рабочего места<input value={form.workplaceCode} onChange={(e)=>setForm({...form,workplaceCode:e.target.value})} placeholder="Можно оставить пустым, если касса одна"/></label>{status&&<div className="settings-status">{status}</div>}<div className="settings-actions"><button onClick={save}>Сохранить</button><button className="primary" disabled={!connection?.configured} onClick={sync}>Синхронизировать</button></div></section><section className="settings-card"><h2>Состояние</h2><dl><div><dt>Режим</dt><dd>{boot.source==='frappe'?'Данные из OS':'Демо-данные'}</dd></div><div><dt>Точка</dt><dd>{boot.pointName}</dd></div><div><dt>Последнее обновление</dt><dd>{boot.lastSyncAt?new Date(boot.lastSyncAt).toLocaleString('ru-RU'):'Ещё не было'}</dd></div><div><dt>Очередь</dt><dd>{boot.pendingSync} операций</dd></div></dl>{connection?.lastError&&<div className="error-note">{connection.lastError}</div>}</section></div></Page>
}
