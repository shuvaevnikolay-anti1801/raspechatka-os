import { useEffect, useMemo, useState } from 'react'
import { calculateDiscountBreakdown } from '../../shared/cart'
import { resolveCurrentCustomer } from '../../shared/customer'
import PaymentModalV2, { type PaymentChoice } from './PaymentModalV2'
import { formatPersonShortName } from './person-name'\nimport ReceiptsPage from './ReceiptsPage'
import type {
  BootState, CashierAuthState, CartLine, CashCount, CashCountLine, CashOperation, CashOperationType, ConnectionConfig, ConnectionStatus,
  Customer, HeldReceipt, ManualDiscount, Order, OrderStatus, PaymentMethod, PaymentPart, Product,
  RemotePaymentConfirmation, SaleDetails, SalePaymentMethod, SaleSummary, ShiftSummary,
  StockWriteOffRequest, SupplyRequestInput, WorkplaceData
} from '../../shared/contracts'

type Screen='sale'|'receipts'|'orders'|'shift'|'work'|'settings'
const money=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2})
const formatMoney=(minor:number)=>money.format(minor/100)
const toMinor=(value:string)=>Math.round((Number(value.replace(',','.'))||0)*100)
const paymentNames:Record<SalePaymentMethod,string>={cash:'Наличные',card:'Карта',qr:'QR / СБП',remote_payment:'Удалённая оплата',mixed:'Смешанная'}
const emptySummary:ShiftSummary={receipts:0,revenueMinor:0,grossRevenueMinor:0,averageCheckBeforeDiscountMinor:0,returnsMinor:0,cashMinor:0,cardMinor:0,qrMinor:0,remotePaymentMinor:0,depositsMinor:0,withdrawalsMinor:0,expectedCashMinor:0}
const emptyWorkplace:WorkplaceData={schedule:[],deliveries:[],supplyRequests:[],cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},orders:[]}

export default function AppV2(){
  const [boot,setBoot]=useState<BootState|null>(null)
  const [auth,setAuth]=useState<CashierAuthState|null>(null)
  const [products,setProducts]=useState<Product[]>([])
  const [sales,setSales]=useState<SaleSummary[]>([])
  const [orders,setOrders]=useState<Order[]>([])
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
  const [manualDiscount,setManualDiscount]=useState<ManualDiscount|null>(null)
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [syncing,setSyncing]=useState(false)
  const [payment,setPayment]=useState<PaymentChoice|null>(null)
  const [returnSale,setReturnSale]=useState<SaleDetails|null>(null)
  const [cashOperation,setCashOperation]=useState<CashOperationType|null>(null)
  const [customerOpen,setCustomerOpen]=useState(false)
  const [manualDiscountOpen,setManualDiscountOpen]=useState(false)
  const [priceOverrideLine,setPriceOverrideLine]=useState<CartLine|null>(null)
  const [cashCountOpen,setCashCountOpen]=useState<CashCount['countType']|null>(null)
  const [orderDraft,setOrderDraft]=useState<{phone:string;comment?:string;dueAt?:string}|null>(null)

  const refresh=async()=>{
    const nextAuth=await window.raspechatkaPos.getCashierAuthState()
    const result=await Promise.all([
      window.raspechatkaPos.getBootState(),window.raspechatkaPos.listProducts(),
      window.raspechatkaPos.listSales(),window.raspechatkaPos.listHeldReceipts(),
      window.raspechatkaPos.getShiftSummary(),window.raspechatkaPos.listCashOperations(),
      window.raspechatkaPos.getConnectionStatus(),window.raspechatkaPos.getWorkplaceData(),window.raspechatkaPos.listOrders(),
      window.raspechatkaPos.getLastCashCount()
    ])
    setBoot(result[0]);setProducts(result[1]);setSales(result[2]);setHeld(result[3])
    setSummary(result[4]);setCashOperations(result[5]);setConnection(result[6])
    setWorkplace(result[7]);setOrders(result[8]);setLastCashCount(result[9])
    setAuth(nextAuth)
  }
  useEffect(()=>{refresh().catch((e)=>setMessage(String(e)))},[])
  useEffect(()=>{
    if(!customer)return
    let cancelled=false
    const reconcile=async()=>{
      const fresh=await resolveCurrentCustomer(customer,window.raspechatkaPos.getCustomer)
      if(!cancelled)setCustomer(fresh)
    }
    reconcile().catch(()=>undefined)
    const timer=window.setInterval(()=>reconcile().catch(()=>undefined),5000)
    return()=>{cancelled=true;window.clearInterval(timer)}
  },[customer?.id])

  const categories=useMemo(()=>['Все',...new Set(products.map((p)=>p.category))],[products])
  const visible=useMemo(()=>{
    const text=query.trim().toLocaleLowerCase('ru')
    return products.filter((p)=>(category==='Все'||p.category===category)&&(!text||(p.name+' '+p.sku+' '+(p.barcode||'')).toLocaleLowerCase('ru').includes(text)))
  },[products,query,category])
  const productById=useMemo(()=>new Map(products.map((p)=>[p.id,p])),[products])
  const discountRules={
    allowDiscounts:Boolean(boot?.rules.allowDiscounts),maxDiscountPercent:boot?.rules.maxDiscountPercent??0,
    reviewDiscountPerReviewMinor:boot?.rules.reviewDiscountPerReviewMinor??0,
  }
  const pricedCart=cart.map((line)=>({...line,preventDiscounts:Boolean(productById.get(line.productId)?.preventDiscounts)}))
  const breakdown=calculateDiscountBreakdown(pricedCart,discountRules,customer?.discountPercent??0,reviewCount,manualDiscount)
  const {subtotalMinor:subtotal,clubDiscountPercent:clubPercent,clubDiscountMinor,reviewDiscountMinor,totalMinor:total}=breakdown
  const reviewUnitMinor=discountRules.allowDiscounts?discountRules.reviewDiscountPerReviewMinor:0
  const safeReviewCount=breakdown.reviewCount
  const maxReviews=reviewUnitMinor>0?Math.floor(Math.max(0,subtotal-clubDiscountMinor-1)/reviewUnitMinor):0
  const preferredPayment:PaymentChoice=boot?.rules.acceptsCash?'cash':boot?.rules.acceptsRemotePayment!==false?'remote_payment':boot?.rules.acceptsCard?'card':'qr'

  const add=(product:Product)=>setCart((current)=>{
    const found=current.find((line)=>line.productId===product.id)
    return found?current.map((line)=>line.productId===product.id?{...line,quantity:line.quantity+1}:line):[...current,{productId:product.id,name:product.name,quantity:1,unitPriceMinor:product.priceMinor,catalogUnitPriceMinor:product.priceMinor,preventDiscounts:product.preventDiscounts}]
  })
  const setQuantity=(id:string,value:number)=>setCart((current)=>current.map((line)=>line.productId===id?{...line,quantity:Math.max(0,Math.round(value*1000)/1000)}:line).filter((line)=>line.quantity>0))
  const change=(id:string,delta:number)=>setCart((current)=>current.map((line)=>line.productId===id?{...line,quantity:Math.round((line.quantity+delta)*1000)/1000}:line).filter((line)=>line.quantity>0))
  const clear=()=>{setCart([]);setCustomer(null);setReviewCount(0);setManualDiscount(null);setOrderDraft(null)}
  const overridePrice=(line:CartLine)=>{
    const product=productById.get(line.productId)
    if(!product||!boot?.rules.allowFreePrice)return
    setPriceOverrideLine(line)
  }
  const syncNow=async()=>{
    if(syncing||busy)return
    setSyncing(true)
    try{
      await window.raspechatkaPos.syncNow();await refresh()
      if(customer)setCustomer(await resolveCurrentCustomer(customer,window.raspechatkaPos.getCustomer))
      setMessage('Данные обновлены')
    }catch{
      await refresh().catch(()=>undefined)
      setMessage('Не удалось связаться с Распечатка OS — продолжаем работать локально')
    }finally{setSyncing(false)}
  }
  const openShift=async()=>{try{await window.raspechatkaPos.openShift();await refresh();setCashCountOpen('opening');setMessage('Смена открыта — пересчитайте стартовые наличные')}catch(e){setMessage(e instanceof Error?e.message:String(e))}}
  const closeShift=async()=>{const x=await window.raspechatkaPos.closeShift();await refresh();setMessage('Смена закрыта: '+x.receipts+' чеков, итог '+formatMoney(x.revenueMinor-x.returnsMinor))}
  const holdReceipt=async()=>{
    if(!cart.length)return
    await window.raspechatkaPos.holdReceipt({label:customer?.name||'Чек на '+formatMoney(total),lines:cart,customer,totalMinor:total,discountPercent:subtotal?breakdown.totalDiscountMinor/subtotal*100:0,reviewCount,manualDiscount})
    clear();await refresh();setMessage('Чек отложен')
  }
  const restoreReceipt=async(receipt:HeldReceipt)=>{
    const fresh=await resolveCurrentCustomer(receipt.customer,window.raspechatkaPos.getCustomer)
    setCart(receipt.lines);setCustomer(fresh);setReviewCount(receipt.reviewCount??0);setManualDiscount(receipt.manualDiscount??null)
    await window.raspechatkaPos.deleteHeldReceipt(receipt.id);await refresh();setScreen('sale')
    const restored=calculateDiscountBreakdown(
      receipt.lines.map((line)=>({...line,preventDiscounts:Boolean(productById.get(line.productId)?.preventDiscounts)})),
      discountRules,fresh?.discountPercent??0,receipt.reviewCount??0,receipt.manualDiscount,
    )
    const requestedManual=receipt.manualDiscount?.type==='amount'
      ? receipt.manualDiscount.value
      : Math.round(Math.max(0,restored.subtotalMinor-restored.clubDiscountMinor-restored.reviewDiscountMinor)*(receipt.manualDiscount?.value??0)/100)
    if(receipt.customer&&!fresh)setMessage('Клиент больше не участвует в активной клубной программе и снят с чека')
    else if(restored.manualDiscountMinor<requestedManual)setMessage('Скидки отложенного чека ограничены актуальными правилами. Проверьте сумму перед оплатой.')
  }
  const complete=async(payments:PaymentPart[],cashReceivedMinor?:number,remotePaymentConfirmation?:RemotePaymentConfirmation)=>{
    if(busy)return
    setBusy(true)
    try{
      if(customer){
        const fresh=await resolveCurrentCustomer(customer,window.raspechatkaPos.getCustomer)
        if(!fresh||fresh.discountPercent!==customer.discountPercent||fresh.name!==customer.name||fresh.phone!==customer.phone){
          setCustomer(fresh);setPayment(null)
          setMessage(fresh?'Скидка клиента обновилась. Проверьте новую сумму и повторите оплату.':'Клиент больше не активен в клубе и снят с чека. Проверьте сумму и повторите оплату.')
          return
        }
      }
      const result=await window.raspechatkaPos.completeSale({
        clientRequestId:crypto.randomUUID(),payments,lines:cart,customer,
        receiptDiscountPercent:subtotal?breakdown.totalDiscountMinor/subtotal*100:0,clubDiscountPercent:clubPercent,
        clubDiscountMinor,reviewCount,reviewDiscountMinor,manualDiscount,
        manualDiscountType:manualDiscount?.type??null,manualDiscountValue:manualDiscount?.value??0,
        manualDiscountMinor:breakdown.manualDiscountMinor,totalDiscountMinor:breakdown.totalDiscountMinor,
        discountRules,discountBreakdown:breakdown,
        cashReceivedMinor,remotePaymentConfirmation,order:orderDraft||undefined
      })
      clear();setPayment(null);await refresh()
      const baseMessage=orderDraft?'Заказ '+(result.order?.orderNumber||'создан')+' принят':'Чек '+result.receiptNumber+' готов'+(result.changeMinor?'. Сдача: '+formatMoney(result.changeMinor):'')
      setMessage(baseMessage)
    }catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  const startReturn=async(sale:SaleSummary)=>{
    if(!boot?.shift){setMessage('Для возврата сначала откройте смену');return}
    try{setReturnSale(await window.raspechatkaPos.getSale(sale.id))}catch(e){setMessage(String(e))}
  }
  const chooseCustomer=(value:Customer|null)=>{setCustomer(value);setReviewCount(0);setCustomerOpen(false)}


  if(!boot||!auth)return <div className="loading"><i/>Запускаем кассу…</div>
  if(auth.status!=='authenticated')return <CashierLogin boot={boot} auth={auth} onAuthenticated={refresh}/>
  return <div className="app-shell">
    <header className="pos-header">
      <nav className="pos-header-nav" aria-label="Разделы кассы">
        <Nav active={screen==='sale'} icon="▣" label="Продажа" onClick={()=>setScreen('sale')}/>
        <Nav active={screen==='receipts'} icon="⌁" label="Чеки" badge={held.length} onClick={()=>setScreen('receipts')}/>
        <Nav active={screen==='orders'} icon="▤" label="Заказы" badge={orders.filter((x)=>!['issued','cancelled'].includes(x.status)).length} onClick={()=>setScreen('orders')}/>
        <Nav active={screen==='shift'} icon="◷" label="Смена" onClick={()=>setScreen('shift')}/>
        <Nav active={screen==='work'} icon="▦" label="Работа" onClick={()=>setScreen('work')}/>
        <Nav active={screen==='settings'} icon="⚙" label="Настройки" onClick={()=>setScreen('settings')}/>
      </nav>
      <div className="pos-header-actions">
        <span className={`pos-header-status ${boot.online?'online':'offline'}`} title={boot.lastSyncAt?'Последняя синхронизация: '+new Date(boot.lastSyncAt).toLocaleString('ru-RU')+' · К отправке: '+boot.pendingSync:'Успешной синхронизации ещё не было · К отправке: '+boot.pendingSync}><i/>{boot.online?'ОС на связи':'Локальный режим'}</span>
        <button className="pos-header-lock" onClick={async()=>setAuth(await window.raspechatkaPos.lockCashier())}>Заблокировать · {formatPersonShortName(boot.cashierName)}</button>
        <button className="pos-header-refresh secondary" disabled={syncing||busy} onClick={()=>void syncNow()}>{syncing?'Синхронизация…':'Обновить данные'}</button>
      </div>
    </header>
    {message&&<div className="toast" onClick={()=>setMessage('')}>{message}<button>×</button></div>}

    {screen==='sale'&&<main className="sale-layout">
      <aside className="categories"><strong>Категории</strong>{categories.map((name)=><button key={name} className={category===name?'active':''} onClick={()=>setCategory(name)}>{name}<span>{name==='Все'?products.length:products.filter((p)=>p.category===name).length}</span></button>)}</aside>
      <section className="catalog">
        <div className="catalog-toolbar"><label className="search"><span>⌕</span><input autoFocus value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Товар, услуга, артикул или штрихкод"/><kbd>F2</kbd></label></div>
        <div className="product-grid">{visible.map((p)=><button className="product-card pos-v2-product" key={p.id} onClick={()=>add(p)}><strong>{p.name}</strong><footer><b>{formatMoney(p.priceMinor)}</b>{p.stock!=null&&<span>Остаток {p.stock}</span>}</footer></button>)}</div>
      </section>
      <aside className="receipt">
        <header><div><small>ТЕКУЩАЯ ПРОДАЖА</small></div><button disabled={!cart.length} onClick={clear}>Очистить</button></header>
        <div className="customer-row"><button onClick={()=>setCustomerOpen(true)}>◎ {customer?.name||'Найти покупателя по телефону'}</button>{customer&&<span>Скидка клуба {clubPercent}% · <button onClick={()=>chooseCustomer(null)}>убрать</button></span>}</div>
        <div className="receipt-lines">{!cart.length?<div className="empty"><i>＋</i><b>Чек пока пуст</b><span>Выберите услугу или найдите её по названию</span></div>:cart.map((line)=><div className="receipt-line" key={line.productId}>
          <div><strong>{line.name}</strong><small>{formatMoney(line.unitPriceMinor)} за ед. {boot.rules.allowFreePrice&&<button onClick={()=>overridePrice(line)}>изменить цену</button>}</small></div>
          <div className="qty pos-v2-qty"><button onClick={()=>change(line.productId,-1)}>−</button><input aria-label={'Количество '+line.name} type="number" min="0.001" step="0.001" value={line.quantity} onChange={(e)=>setQuantity(line.productId,Number(e.target.value))}/><button onClick={()=>change(line.productId,1)}>+</button></div>
          <b>{formatMoney(line.quantity*line.unitPriceMinor)}</b>
        </div>)}</div>
        <footer className="receipt-total">
          {clubDiscountMinor>0&&<div className="subtotal"><span>Скидка клуба {clubPercent}%</span><strong>− {formatMoney(clubDiscountMinor)}</strong></div>}
          <div className={'review-discount-row '+(!discountRules.allowDiscounts?'disabled':'')}><div><span>Отзывы</span><small>{reviewUnitMinor>0?`${formatMoney(reviewUnitMinor)} за отзыв`:'Скидка не настроена'}</small></div><div className="review-count"><button disabled={!discountRules.allowDiscounts||safeReviewCount<=0} onClick={()=>setReviewCount(Math.max(0,safeReviewCount-1))}>−</button><input type="number" min="0" max={maxReviews} step="1" value={safeReviewCount} disabled={!discountRules.allowDiscounts||reviewUnitMinor<=0} onChange={(e)=>setReviewCount(Math.max(0,Math.floor(Number(e.target.value)||0)))}/><button disabled={!discountRules.allowDiscounts} onClick={()=>setReviewCount(safeReviewCount+1)}>+</button></div><strong>{reviewDiscountMinor?`− ${formatMoney(reviewDiscountMinor)}`:'—'}</strong></div>
          <div className="review-discount-row"><div><span>Доп. скидка{manualDiscount?.type==='percent'?` ${manualDiscount.value}%`:''}</span><small>Ограничена настройками точки</small></div><button disabled={!discountRules.allowDiscounts} onClick={()=>setManualDiscountOpen(true)}>{manualDiscount?'Изменить':'Скидка'}</button><strong>{breakdown.manualDiscountMinor?`− ${formatMoney(breakdown.manualDiscountMinor)}`:'—'}</strong></div>
          {cart.some((line)=>productById.get(line.productId)?.preventDiscounts)&&<div className="discount-warning">На отмеченные позиции скидка не применяется.</div>}
          {breakdown.totalDiscountMinor>0&&<div className="subtotal"><span>Без скидок</span><s>{formatMoney(subtotal)}</s></div>}
          <div className="total"><span>Итого</span><strong>{formatMoney(total)}</strong></div>
          {!boot.shift?<button className="primary wide" onClick={openShift}>Открыть смену</button>:<>
            <div className="receipt-actions pos-v2-actions"><button disabled={!cart.length} onClick={holdReceipt}>Отложить</button><button disabled={!cart.length} onClick={()=>setOrderDraft({phone:customer?.phone||'',comment:''})}>Оформить заказ</button><button className="primary pos-v2-pay" disabled={!cart.length} onClick={()=>setPayment(preferredPayment)}>К оплате · {formatMoney(total)}</button></div>
            <small className="training">ККТ и оборудование проверяются перед каждой оплатой</small>
          </>}
        </footer>
      </aside>
    </main>}

    {screen==='receipts'&&<ReceiptsPage boot={boot} sales={sales} held={held} returns={returns} onPrint={printSale} onReturn={startReturn} onRestore={restoreReceipt} onRefresh={refresh} notify={setMessage}/>}
    {screen==='orders'&&<OrdersPage orders={orders} onChanged={refresh} notify={setMessage}/>} 
    {screen==='shift'&&<Page title="Текущая смена" kicker="">
      <div className="metrics pos-v2-metrics"><Metric label="Продажи" value={formatMoney(summary.revenueMinor)}/><Metric label="Средний чек без скидок" value={formatMoney(summary.averageCheckBeforeDiscountMinor??0)}/><Metric label="Возвраты" value={'− '+formatMoney(summary.returnsMinor)}/><Metric label="В кассе ожидается" value={formatMoney(summary.expectedCashMinor)}/><Metric label="Чеков" value={String(summary.receipts)}/></div>
      <section className="shift-card"><div><small>КАССИР</small><h2>{formatPersonShortName(boot.cashierName)}</h2><p>{boot.shift?'Начало: '+new Date(boot.shift.openedAt).toLocaleString('ru-RU'):'Откройте смену, чтобы проводить продажи'}</p>{lastCashCount&&<small>Последний пересчёт: {formatMoney(lastCashCount.totalMinor)} · расхождение {formatMoney(lastCashCount.differenceMinor)}</small>}</div>{boot.shift?<div className="shift-actions"><button onClick={()=>setCashCountOpen('control')}>Пересчитать кассу</button><button onClick={()=>setCashOperation('deposit')}>Внести деньги</button><button onClick={()=>setCashOperation('withdrawal')}>Изъять деньги</button><button className="danger" onClick={()=>setCashCountOpen('closing')}>Закрыть смену</button></div>:<button className="primary" onClick={openShift}>Открыть смену</button>}</section>
      {boot.shift&&<div className="shift-details"><section><h3>Оплаты</h3><dl><div><dt>Наличные продажи</dt><dd>{formatMoney(summary.cashMinor)}</dd></div><div><dt>Карта</dt><dd>{formatMoney(summary.cardMinor)}</dd></div><div><dt>QR / СБП</dt><dd>{formatMoney(summary.qrMinor)}</dd></div><div><dt>Удалённая оплата</dt><dd>{formatMoney(summary.remotePaymentMinor??0)}</dd></div><div><dt>Внесения</dt><dd>{formatMoney(summary.depositsMinor)}</dd></div><div><dt>Изъятия</dt><dd>− {formatMoney(summary.withdrawalsMinor)}</dd></div></dl></section><section><h3>Движения наличных</h3>{cashOperations.length?cashOperations.map((x)=><article key={x.id}><div><b>{x.type==='deposit'?'Внесение':'Изъятие'}</b><small>{x.reason} · {new Date(x.createdAt).toLocaleTimeString('ru-RU')}</small></div><strong>{x.type==='deposit'?'+':'−'} {formatMoney(x.amountMinor)}</strong></article>):<p>Операций пока нет</p>}</section></div>}
    </Page>}
    {screen==='work'&&<WorkPage products={products} data={workplace} shiftOpen={Boolean(boot.shift)} onChanged={refresh} notify={setMessage}/>} 
    {screen==='settings'&&<Settings boot={boot} connection={connection} onSaved={refresh} onSynced={async()=>{await refresh();if(customer)setCustomer(await resolveCurrentCustomer(customer,window.raspechatkaPos.getCustomer));setMessage('Каталог, клиенты, настройки и очередь операций синхронизированы')}}/>}

    {payment&&<PaymentModalV2 choice={payment} total={total} rules={boot.rules} busy={busy} onChoice={setPayment} onClose={()=>setPayment(null)} onComplete={complete}/>}
    {orderDraft&&<OrderModal draft={orderDraft} total={total} onClose={()=>setOrderDraft(null)} onPay={()=>setPayment(preferredPayment)} onSave={async(d)=>{try{const o=await window.raspechatkaPos.createUnpaidOrder({phone:d.phone,lines:cart,comment:d.comment,dueAt:d.dueAt});setOrderDraft(null);clear();await refresh();setMessage('Заказ '+o.orderNumber+' сохранён без оплаты')}catch(e){setMessage(e instanceof Error?e.message:String(e))}}}/>} 
    {returnSale&&<ReturnModal sale={returnSale} busy={busy} onClose={()=>setReturnSale(null)} onComplete={async(lines,payments)=>{setBusy(true);try{const x=await window.raspechatkaPos.createReturn({clientRequestId:crypto.randomUUID(),saleId:returnSale.id,lines,payments});setReturnSale(null);await refresh();setMessage('Возврат '+x.receiptNumber+' оформлен на '+formatMoney(x.totalMinor))}catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}}/>} 
    {cashOperation&&<CashOperationModal type={cashOperation} onClose={()=>setCashOperation(null)} onComplete={async(amount,reason)=>{try{await window.raspechatkaPos.addCashOperation(cashOperation,amount,reason);setCashOperation(null);await refresh();setMessage('Операция с наличными сохранена')}catch(e){setMessage(String(e))}}}/>} 
    {customerOpen&&<CustomerModal selected={customer} onClose={()=>setCustomerOpen(false)} onSelect={chooseCustomer}/>}
    {manualDiscountOpen&&<ManualDiscountModal lines={pricedCart} rules={discountRules} clubPercent={customer?.discountPercent??0} reviewCount={reviewCount} current={manualDiscount} onClose={()=>setManualDiscountOpen(false)} onApply={(value)=>{setManualDiscount(value);setManualDiscountOpen(false)}}/>}
    {priceOverrideLine&&<PriceOverrideModal line={priceOverrideLine} minimumMinor={productById.get(priceOverrideLine.productId)?.minimumSalePriceMinor??0} onClose={()=>setPriceOverrideLine(null)} onApply={(price)=>{const product=productById.get(priceOverrideLine.productId)!;setCart((current)=>current.map((item)=>item.productId===priceOverrideLine.productId?{...item,unitPriceMinor:price,catalogUnitPriceMinor:item.catalogUnitPriceMinor??product.priceMinor}:item));setPriceOverrideLine(null)}}/>}
    {cashCountOpen&&<CashCountModal type={cashCountOpen} expectedMinor={summary.expectedCashMinor} onClose={()=>setCashCountOpen(null)} onComplete={async(lines)=>{try{const count=await window.raspechatkaPos.saveCashCount(cashCountOpen,lines);setCashCountOpen(null);await refresh();if(count.countType==='closing'){await closeShift()}else setMessage('Пересчёт сохранён. Расхождение: '+formatMoney(count.differenceMinor))}catch(e){setMessage(e instanceof Error?e.message:String(e))}}}/>} 
  </div>
}

function CashierLogin({boot,auth,onAuthenticated}:{boot:BootState;auth:CashierAuthState;onAuthenticated:()=>Promise<void>}){
  const forced=auth.openShiftCashierId
  const [employeeId,setEmployeeId]=useState(forced||'')
  const [pin,setPin]=useState('')
  const [confirmation,setConfirmation]=useState('')
  const [setup,setSetup]=useState(false)
  const [adminReset,setAdminReset]=useState(false)
  const [adminCode,setAdminCode]=useState('')
  const [error,setError]=useState('')
  const selected=boot.employees.find((row)=>row.id===employeeId)||(forced===employeeId?{id:employeeId,name:auth.openShiftCashierName||employeeId}:undefined)
  const numeric=(value:string)=>value.replace(/\D/g,'').slice(0,4)
  const choose=async(id:string)=>{setEmployeeId(id);setPin('');setConfirmation('');setError('');if(id){try{setSetup((await window.raspechatkaPos.beginCashierLogin(id)).requiresPinSetup)}catch(e){setError(e instanceof Error?e.message:String(e))}}}
  useEffect(()=>{if(forced)void choose(forced)},[forced])
  const submit=async()=>{try{
    if(auth.status==='locked')await window.raspechatkaPos.unlockCashier(pin)
    else if(setup)await window.raspechatkaPos.createCashierPin(employeeId,pin,confirmation)
    else await window.raspechatkaPos.loginCashier(employeeId,pin)
    await onAuthenticated()
  }catch(e){setError(e instanceof Error?e.message:String(e));setPin('');setConfirmation('')}}
  const reset=async()=>{try{await window.raspechatkaPos.resetCashierPin(employeeId,adminCode,pin,confirmation);setAdminReset(false);setAdminCode('');setSetup(false);setError('PIN изменён. Теперь войдите с новым PIN.');setPin('');setConfirmation('')}catch(e){setError(e instanceof Error?e.message:String(e))}}
  const lockedEmployee=auth.employee
  return <main className="cashier-login-screen"><section className="cashier-login-card">
    <small>{auth.status==='locked'?'КАССА ЗАБЛОКИРОВАНА':'КТО РАБОТАЕТ?'}</small><h1>{auth.status==='locked'?formatPersonShortName(lockedEmployee?.name):'Выберите себя'}</h1>
    {forced&&<p>После перезапуска открытую смену может продолжить только <b>{formatPersonShortName(auth.openShiftCashierName)}</b>.</p>}
    {auth.status!=='locked'&&!forced&&<div className="cashier-list">{boot.employees.map((employee)=><button key={employee.id} className={employeeId===employee.id?'active':''} onClick={()=>void choose(employee.id)}>{formatPersonShortName(employee.name)}</button>)}</div>}
    {!boot.employees.length&&<p>Нет подтверждённых кассиров этой точки. Выполните синхронизацию в настройках.</p>}
    {(selected||lockedEmployee)&&<form onSubmit={(event)=>{event.preventDefault();void (adminReset?reset():submit())}}>
      {adminReset&&<label><span>Код администратора</span><input autoFocus type="password" inputMode="numeric" maxLength={4} value={adminCode} onChange={(e)=>setAdminCode(numeric(e.target.value))}/></label>}
      <label><span>{setup||adminReset?'Новый PIN':'PIN кассира'}</span><input autoFocus={!adminReset} type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e)=>setPin(numeric(e.target.value))}/></label>
      {(setup||adminReset)&&<label><span>Повторите PIN</span><input type="password" inputMode="numeric" maxLength={4} value={confirmation} onChange={(e)=>setConfirmation(numeric(e.target.value))}/></label>}
      {error&&<div className="cashier-login-error">{error}</div>}
      <button className="primary" type="submit">{adminReset?'Сбросить PIN':setup?'Создать PIN и войти':'Войти'}</button>
      {auth.status!=='locked'&&!setup&&!adminReset&&<button type="button" onClick={()=>{setAdminReset(true);setPin('');setConfirmation('');setError('')}}>Забыли PIN?</button>}
    </form>}
    {auth.status!=='locked'&&<button className="settings-open-trigger" type="button">Настройки кассы</button>}
  </section></main>
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

function CustomerModal({selected,onClose,onSelect}:{selected:Customer|null;onClose:()=>void;onSelect:(value:Customer|null)=>void}){
  const [query,setQuery]=useState('')
  const [visible,setVisible]=useState<Customer[]>([])
  const [searching,setSearching]=useState(false)
  const digits=query.replace(/\D/g,'')
  useEffect(()=>{let cancelled=false;if(digits.length<4){setVisible([]);setSearching(false);return};const timer=window.setTimeout(async()=>{setSearching(true);try{const rows=await window.raspechatkaPos.listCustomers(digits);if(!cancelled)setVisible(rows)}finally{if(!cancelled)setSearching(false)}},120);return()=>{cancelled=true;window.clearTimeout(timer)}},[digits])
  const overflow=visible.length>50
  const rows=visible.slice(0,50)
  return <div className="modal-backdrop"><div className="payment-modal customer-modal"><header><div><small>ЛОКАЛЬНАЯ БАЗА КЛИЕНТОВ</small><h2>Выбрать покупателя</h2></div><button onClick={onClose}>×</button></header><label className="customer-search"><span>⌕</span><input autoFocus inputMode="numeric" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Введите минимум 4 цифры телефона"/></label><div className="customer-list"><button className={!selected?'active':''} onClick={()=>onSelect(null)}><div><b>Розничный покупатель</b><small>Без персональной скидки</small></div></button>{overflow&&<div className="pilot-empty">Найдено слишком много клиентов. Введите ещё несколько цифр.</div>}{rows.map((x)=><button key={x.id} className={selected?.id===x.id?'active':''} onClick={()=>onSelect(x)}><div><b>{x.name}</b><small>{x.phone}</small></div><strong className="club-badge">Скидка {x.discountPercent}%</strong></button>)}{!searching&&digits.length<4&&<div className="pilot-empty">Поиск выполняется только по телефону. Введите последние 4 цифры или больше.</div>}{!searching&&digits.length>=4&&!visible.length&&<div className="pilot-empty">В локальном кэше совпадений нет</div>}</div></div></div>
}

function ManualDiscountModal({lines,rules,clubPercent,reviewCount,current,onClose,onApply}:{
  lines:CartLine[];rules:{allowDiscounts:boolean;maxDiscountPercent:number;reviewDiscountPerReviewMinor:number};
  clubPercent:number;reviewCount:number;current:ManualDiscount|null;onClose:()=>void;onApply:(value:ManualDiscount|null)=>void
}){
  const [type,setType]=useState<ManualDiscount['type']>(current?.type??'percent')
  const [input,setInput]=useState(current?(current.type==='amount'?String(current.value/100):String(current.value)):'')
  const value=type==='amount'?toMinor(input):Math.max(0,Number(input.replace(',','.'))||0)
  const draft:ManualDiscount={type,value}
  const preview=calculateDiscountBreakdown(lines,rules,clubPercent,reviewCount,draft)
  return <div className="modal-backdrop"><div className="payment-modal compact-modal"><header><div><small>ТЕКУЩИЙ ЧЕК</small><h2>Дополнительная скидка</h2></div><button onClick={onClose}>×</button></header><div className="form-row"><button className={type==='percent'?'active':''} onClick={()=>setType('percent')}>%</button><button className={type==='amount'?'active':''} onClick={()=>setType('amount')}>₽</button></div><label className="cash-input"><span>{type==='percent'?'Процент':'Сумма, ₽'}</span><input autoFocus type="number" min="0" step={type==='amount'?'0.01':'0.1'} value={input} onChange={(event)=>setInput(event.target.value)}/></label><div className="settings-status">Будет применено: <b>{formatMoney(preview.manualDiscountMinor)}</b><br/>Новый итог: <b>{formatMoney(preview.totalMinor)}</b></div><div className="settings-actions"><button onClick={()=>onApply(null)}>Убрать скидку</button><button className="primary" onClick={()=>onApply(draft)}>Применить</button></div></div></div>
}

function PriceOverrideModal({line,minimumMinor,onClose,onApply}:{line:CartLine;minimumMinor:number;onClose:()=>void;onApply:(price:number)=>void}){
  const [input,setInput]=useState(String(line.unitPriceMinor/100))
  const price=toMinor(input)
  const valid=price>=minimumMinor
  return <div className="modal-backdrop"><div className="payment-modal compact-modal"><header><div><small>ПОЗИЦИЯ ЧЕКА</small><h2>Изменить цену</h2></div><button onClick={onClose}>×</button></header><p>{line.name}</p><label className="cash-input"><span>Цена за единицу, ₽</span><input autoFocus type="number" min={minimumMinor/100} step="0.01" value={input} onChange={(event)=>setInput(event.target.value)}/></label>{!valid&&<div className="error-note">Минимальная цена: {formatMoney(minimumMinor)}</div>}<button className="primary confirm" disabled={!valid} onClick={()=>onApply(price)}>Применить · {formatMoney(price)}</button></div></div>
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
