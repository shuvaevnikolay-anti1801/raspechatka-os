import { useEffect, useMemo, useState } from 'react'
import { calculateDiscountBreakdown } from '../../shared/cart'
import { resolveCurrentCustomer } from '../../shared/customer'
import PaymentModalV2, { type PaymentChoice } from './PaymentModalV2'
import SaleWorkspace from './SaleWorkspace'
import SaleCatalog, { FAVORITES_CATEGORY, SaleCategories } from './SaleCatalog'
import CurrentReceipt from './CurrentReceipt'
import { formatPersonShortName } from './person-name'
import { formatMoney } from './money'
import { findUpsellRuleForProduct, resolveUpsellAfterCart, selectUpsellCandidate, type UpsellCycle } from '../../shared/upsell'
import OrdersPage from './OrdersPage'
import ReceiptsPage from './ReceiptsPage'
import { PinEntryLayout, PinInput } from './PinEntry'
import { PosButton } from './ui/PosButton'
import { PosField } from './ui/PosField'
import { PosModal } from './ui/PosModal'
import { PosIcon, type PosIconName } from './ui/PosIcon'
import WorkPage from './WorkPage'
import type {
  BootState, CashierAuthState, CartLine, CashCount, CashCountLine, CashOperation, CashOperationType,
  Customer, HeldReceipt, ManualDiscount, Order, PaymentMethod, PaymentPart, Product,
  RemotePaymentConfirmation, SaleDetails, SalePaymentMethod, SaleSummary, ShiftSummary, WorkplaceData
} from '../../shared/contracts'

type Screen='sale'|'receipts'|'orders'|'shift'|'work'
const toMinor=(value:string)=>Math.round((Number(value.replace(',','.'))||0)*100)
const paymentNames:Record<SalePaymentMethod,string>={cash:'Наличные',card:'Карта',qr:'QR / СБП',remote_payment:'Удалённая оплата',mixed:'Смешанная'}
const emptySummary:ShiftSummary={receipts:0,revenueMinor:0,grossRevenueMinor:0,averageCheckBeforeDiscountMinor:0,returnsMinor:0,cashMinor:0,cardMinor:0,qrMinor:0,remotePaymentMinor:0,depositsMinor:0,withdrawalsMinor:0,expectedCashMinor:0}
const emptyWorkplace:WorkplaceData={schedule:[],scheduleMonth:{month:'',days:0,employees:[],entries:[]},myUpcomingShifts:[],operationalCatalog:[],deliveries:[],supplyRequests:[],cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},orders:[]}
export const TOAST_DISMISS_MS=3000
export const EXPECTED_CASH_LABEL='Денег в кассе'
export const manualSyncMessage=(result:BootState)=>{
  if(result.documentQueueError){
    const master=result.masterDataError?` Справочники не обновлены: ${result.masterDataError}.`:' Справочники обновлены.'
    return `Связь с сервером есть.${master} Очередь документов не отправлена: ${result.documentQueueError}. Осталось: ${result.pendingSync}`
  }
  if(result.pendingSync>0)return `Сервер доступен, но в очереди осталось документов: ${result.pendingSync}`
  if(result.masterDataError)return `Документы отправлены, но справочники не обновлены: ${result.masterDataError}`
  return 'Данные обновлены'
}
export type ReceiptDiscountInputState={customer:Customer|null;reviewCount:number;manualDiscount:ManualDiscount|null}
export const replaceReceiptCustomer=(state:ReceiptDiscountInputState,customer:Customer|null):ReceiptDiscountInputState=>({...state,customer})
export const emptyReceiptDiscountInputs=():ReceiptDiscountInputState=>({customer:null,reviewCount:0,manualDiscount:null})
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
  const [screen,setScreen]=useState<Screen>('sale')
  const [query,setQuery]=useState('')
  const [category,setCategory]=useState(FAVORITES_CATEGORY)
  const [cart,setCart]=useState<CartLine[]>([])
  const [upsellCycle,setUpsellCycle]=useState<UpsellCycle>({state:'eligible'})
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
      window.raspechatkaPos.getWorkplaceData(),window.raspechatkaPos.listOrders(),window.raspechatkaPos.getLastCashCount()
    ])
    setBoot(result[0]);setProducts(result[1]);setSales(result[2]);setHeld(result[3])
    setSummary(result[4]);setCashOperations(result[5])
    setWorkplace(result[6]);setOrders(result[7]);setLastCashCount(result[8])
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
  useEffect(()=>{
    if(!message)return
    const timer=window.setTimeout(()=>setMessage((current)=>current===message?'':current),TOAST_DISMISS_MS)
    return()=>window.clearTimeout(timer)
  },[message])

  const productById=useMemo(()=>new Map(products.map((p)=>[p.id,p])),[products])
  const activeUpsellProduct=upsellCycle.state==='showing'&&upsellCycle.candidate?productById.get(upsellCycle.candidate.item):undefined
  const saleProductIds=useMemo(()=>products.map((product)=>product.id),[products])
  const discountRules={
    allowDiscounts:Boolean(boot?.rules.allowDiscounts),maxDiscountPercent:boot?.rules.maxDiscountPercent??0,
    reviewDiscountPerReviewMinor:boot?.rules.reviewDiscountPerReviewMinor??0,
  }
  const pricedCart=cart.map((line)=>({...line,preventDiscounts:Boolean(productById.get(line.productId)?.preventDiscounts)}))
  const breakdown=calculateDiscountBreakdown(pricedCart,discountRules,customer?.discountPercent??0,reviewCount,manualDiscount)
  const {subtotalMinor:subtotal,clubDiscountPercent:clubPercent,clubDiscountMinor,reviewDiscountMinor,roundingAdjustmentMinor,payableMinor:total}=breakdown
  const reviewUnitMinor=discountRules.allowDiscounts?discountRules.reviewDiscountPerReviewMinor:0
  const safeReviewCount=breakdown.reviewCount
  const maxReviews=reviewUnitMinor>0?Math.floor(Math.max(0,subtotal-clubDiscountMinor-1)/reviewUnitMinor):0
  const preferredPayment:PaymentChoice=boot?.rules.acceptsCash?'cash':boot?.rules.acceptsRemotePayment!==false?'remote_payment':boot?.rules.acceptsCard?'card':'qr'

  const add=(product:Product,options:{suppressUpsell?:boolean}={})=>{
    const found=cart.find((line)=>line.productId===product.id)
    const next=found
      ? cart.map((line)=>line.productId===product.id?{...line,quantity:line.quantity+1}:line)
      : [...cart,{productId:product.id,name:product.name,quantity:1,unitPriceMinor:product.priceMinor,catalogUnitPriceMinor:product.priceMinor,preventDiscounts:product.preventDiscounts}]
    setCart(next)
    if(options.suppressUpsell||upsellCycle.state!=='eligible')return
    const rule=findUpsellRuleForProduct(boot?.upsellRules??[],product.id)
    if(!rule)return
    const selection=selectUpsellCandidate(rule,products,next,boot?.upsellCursors[rule.triggerItem]??0)
    if(!selection.candidate)return
    const nextCursor=selection.nextCursor
    setBoot((current)=>current?{...current,upsellCursors:{...current.upsellCursors,[rule.triggerItem]:nextCursor}}:current)
    void window.raspechatkaPos.setUpsellCursor(rule.triggerItem,nextCursor).catch(()=>setMessage('Не удалось сохранить очередь рекомендаций локально'))
    setUpsellCycle({state:'showing',triggerItem:rule.triggerItem,candidate:selection.candidate})
  }
  const updateCart=(next:CartLine[])=>{
    setCart(next)
    setUpsellCycle((current)=>resolveUpsellAfterCart(current,next))
  }
  const setQuantity=(id:string,value:number)=>updateCart(cart.map((line)=>line.productId===id?{...line,quantity:Math.max(0,Math.round(value*1000)/1000)}:line).filter((line)=>line.quantity>0))
  const change=(id:string,delta:number)=>updateCart(cart.map((line)=>line.productId===id?{...line,quantity:Math.round((line.quantity+delta)*1000)/1000}:line).filter((line)=>line.quantity>0))
  const clear=()=>{const empty=emptyReceiptDiscountInputs();setCart([]);setCustomer(empty.customer);setReviewCount(empty.reviewCount);setManualDiscount(empty.manualDiscount);setOrderDraft(null);setUpsellCycle({state:'eligible'})}
  const dismissUpsell=()=>setUpsellCycle({state:'resolved'})
  const acceptUpsell=()=>{
    const target=upsellCycle.candidate&&productById.get(upsellCycle.candidate.item)
    setUpsellCycle({state:'resolved'})
    if(target)add(target,{suppressUpsell:true})
  }
  const overridePrice=(line:CartLine)=>{
    const product=productById.get(line.productId)
    if(!product||!boot?.rules.allowFreePrice)return
    setPriceOverrideLine(line)
  }
  const syncNow=async()=>{
    if(syncing||busy)return
    setSyncing(true)
    try{
      const result=await window.raspechatkaPos.syncNow();await refresh()
      if(customer)setCustomer(await resolveCurrentCustomer(customer,window.raspechatkaPos.getCustomer))
      setMessage(manualSyncMessage(result))
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
    setUpsellCycle({state:'eligible'})
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
        clientRequestId:crypto.randomUUID(),payableMinor:total,roundingAdjustmentMinor,discountBreakdown:breakdown,payments,lines:cart,customer,
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
  const chooseCustomer=(value:Customer|null)=>{const next=replaceReceiptCustomer({customer,reviewCount,manualDiscount},value);setCustomer(next.customer);setCustomerOpen(false)}


  if(!boot||!auth)return <div className="loading"><i/>Запускаем кассу…</div>
  if(auth.status!=='authenticated')return <CashierLogin boot={boot} auth={auth} onAuthenticated={refresh}/>
  return <div className="app-shell">
    <header className="pos-header">
      <nav className="pos-header-nav" aria-label="Разделы кассы">
        <Nav active={screen==='sale'} icon={NAV_ICON_MAP.sale} label="Продажа" onClick={()=>setScreen('sale')}/>
        <Nav active={screen==='receipts'} icon={NAV_ICON_MAP.receipts} label="Чеки" badge={held.length} onClick={()=>setScreen('receipts')}/>
        <Nav active={screen==='orders'} icon={NAV_ICON_MAP.orders} label="Заказы" badge={orders.filter((x)=>x.paymentStatus==='paid'&&(x.status==='new'||x.status==='in_progress')).length} onClick={()=>setScreen('orders')}/>
        <Nav active={screen==='shift'} icon={NAV_ICON_MAP.shift} label="Смена" onClick={()=>setScreen('shift')}/>
        <Nav active={screen==='work'} icon={NAV_ICON_MAP.work} label="Работа" onClick={()=>setScreen('work')}/>
        <SettingsNavTrigger/>
      </nav>
      <div className="pos-header-actions">
        <span className={`pos-header-status ${boot.online?'online':'offline'}`} title={boot.lastSyncAt?'Последняя синхронизация: '+new Date(boot.lastSyncAt).toLocaleString('ru-RU')+' · К отправке: '+boot.pendingSync:'Успешной синхронизации ещё не было · К отправке: '+boot.pendingSync}><i/>{boot.online?'ОС на связи':'Локальный режим'}</span>
        <PosButton className="pos-header-lock" variant="quiet" size="compact" icon={<PosIcon name="lock"/>} onClick={async()=>setAuth(await window.raspechatkaPos.lockCashier())}>Заблокировать · {formatPersonShortName(boot.cashierName)}</PosButton>
        <PosButton className="pos-header-refresh" variant="secondary" size="compact" icon={<PosIcon name="refresh"/>} disabled={syncing||busy} onClick={()=>void syncNow()}>{syncing?'Синхронизация…':'Обновить данные'}</PosButton>
      </div>
    </header>
    {message&&<div className="toast" role="status" onClick={()=>setMessage('')}>{message}<PosButton variant="quiet" size="icon" aria-label="Закрыть уведомление"><PosIcon name="close"/></PosButton></div>}

    {screen==='sale'&&<SaleWorkspace
      productIds={saleProductIds}
      categories={()=><SaleCategories products={products} selected={category} onSelect={setCategory}/>}
      catalog={(favoriteProductIds,onToggleFavorite)=><SaleCatalog products={products} query={query} category={category} favoriteProductIds={favoriteProductIds} onQueryChange={setQuery} onAdd={add} onToggleFavorite={onToggleFavorite}/>} 
      receipt={<CurrentReceipt
        lines={cart}
        customer={customer}
        clubPercent={clubPercent}
        allowFreePrice={Boolean(boot.rules.allowFreePrice)}
        onClear={clear}
        onOpenCustomer={()=>setCustomerOpen(true)}
        onRemoveCustomer={()=>chooseCustomer(null)}
        onOverridePrice={overridePrice}
        onChangeQuantity={change}
        onSetQuantity={setQuantity}
        upsell={upsellCycle.state==='showing'&&upsellCycle.candidate&&activeUpsellProduct?{
          cashierPhrase:upsellCycle.candidate.cashierPhrase||'Предложите покупателю: '+activeUpsellProduct.name,
          name:activeUpsellProduct.name,
          priceMinor:activeUpsellProduct.priceMinor,
        }:null}
        onAcceptUpsell={acceptUpsell}
        onDismissUpsell={dismissUpsell}
        allowDiscounts={discountRules.allowDiscounts}
        reviewUnitMinor={reviewUnitMinor}
        reviewCount={safeReviewCount}
        reviewDiscountMinor={reviewDiscountMinor}
        maxReviews={maxReviews}
        onReviewCountChange={setReviewCount}
        manualDiscount={manualDiscount}
        manualDiscountMinor={breakdown.manualDiscountMinor}
        onOpenManualDiscount={()=>setManualDiscountOpen(true)}
        clubDiscountMinor={clubDiscountMinor}
        hasProtectedItems={cart.some((line)=>productById.get(line.productId)?.preventDiscounts)}
        subtotalMinor={subtotal}
        totalDiscountMinor={breakdown.totalDiscountMinor}
        roundingAdjustmentMinor={roundingAdjustmentMinor}
        totalMinor={total}
        shiftOpen={Boolean(boot.shift)}
        onOpenShift={openShift}
        onHold={holdReceipt}
        onCreateOrder={()=>setOrderDraft({phone:customer?.phone||'',comment:'',dueAt:''})}
        onPay={()=>{if(total>0)setPayment(preferredPayment)}}
      />}
    />}

    {screen==='receipts'&&<ReceiptsPage boot={boot} sales={sales} held={held} onReturn={startReturn} onRestore={restoreReceipt} notify={setMessage}/>}
    {screen==='orders'&&<OrdersPage orders={orders} onChanged={refresh} notify={setMessage}/>} 
    {screen==='shift'&&<Page title="Текущая смена" kicker="">
      <div className="metrics pos-v2-metrics"><Metric label="Продажи" value={formatMoney(summary.revenueMinor)}/><Metric label="Средний чек без скидок" value={formatMoney(summary.averageCheckBeforeDiscountMinor??0)}/><Metric label="Возвраты" value={'− '+formatMoney(summary.returnsMinor)}/><Metric label={EXPECTED_CASH_LABEL} value={formatMoney(summary.expectedCashMinor)}/><Metric label="Чеков" value={String(summary.receipts)}/></div>
      <section className="shift-card"><div className="shift-cashier"><small>Кассир</small><h2>{formatPersonShortName(boot.cashierName)}</h2><p>{boot.shift?'Начало: '+new Date(boot.shift.openedAt).toLocaleString('ru-RU'):'Откройте смену, чтобы проводить продажи'}</p>{lastCashCount&&<p>Последний пересчёт: {formatMoney(lastCashCount.totalMinor)} · расхождение {formatMoney(lastCashCount.differenceMinor)}</p>}</div>{!boot.shift&&<PosButton variant="primary" onClick={openShift}>Открыть смену</PosButton>}</section>
      {boot.shift&&<div className="shift-details"><section><h3>Оплаты</h3><dl><div><dt>Наличные продажи</dt><dd>{formatMoney(summary.cashMinor)}</dd></div><div><dt>Карта</dt><dd>{formatMoney(summary.cardMinor)}</dd></div><div><dt>QR / СБП</dt><dd>{formatMoney(summary.qrMinor)}</dd></div><div><dt>Удалённая оплата</dt><dd>{formatMoney(summary.remotePaymentMinor??0)}</dd></div><div><dt>Внесения</dt><dd>{formatMoney(summary.depositsMinor)}</dd></div><div><dt>Изъятия</dt><dd>− {formatMoney(summary.withdrawalsMinor)}</dd></div></dl></section><section className="shift-cash"><div className="shift-cash-heading"><h3>Движения наличных</h3><div className="shift-actions"><PosButton variant="secondary" onClick={()=>setCashCountOpen('control')}>Пересчитать кассу</PosButton><PosButton variant="secondary" onClick={()=>setCashOperation('deposit')}>Внести деньги</PosButton><PosButton variant="secondary" onClick={()=>setCashOperation('withdrawal')}>Изъять деньги</PosButton></div></div>{cashOperations.length?cashOperations.map((x)=><article key={x.id}><div><b>{x.type==='deposit'?'Внесение':'Изъятие'}</b><small>{x.reason} · {new Date(x.createdAt).toLocaleTimeString('ru-RU')}</small></div><strong>{x.type==='deposit'?'+':'−'} {formatMoney(x.amountMinor)}</strong></article>):<p className="shift-empty">Операций пока нет</p>}</section></div>}
    {boot.shift&&<div className="shift-close"><PosButton variant="danger" onClick={()=>setCashCountOpen('closing')}>Закрыть смену</PosButton></div>}
    </Page>}
    {screen==='work'&&<WorkPage products={products} data={workplace} shiftOpen={Boolean(boot.shift)} onChanged={refresh} notify={setMessage}/>} {payment&&<PaymentModalV2 choice={payment} total={total} rules={boot.rules} busy={busy} onChoice={setPayment} onClose={()=>setPayment(null)} onComplete={complete}/>}
    {orderDraft&&!payment&&<OrderModal draft={orderDraft} total={total} onChange={setOrderDraft} onClose={()=>setOrderDraft(null)} onPay={()=>setPayment(preferredPayment)}/>} 
    {returnSale&&<ReturnModal sale={returnSale} busy={busy} onClose={()=>setReturnSale(null)} onComplete={async(lines,payments)=>{setBusy(true);try{const x=await window.raspechatkaPos.createReturn({clientRequestId:crypto.randomUUID(),saleId:returnSale.id,lines,payments});setReturnSale(null);await refresh();setMessage('Возврат '+x.receiptNumber+' оформлен на '+formatMoney(x.totalMinor))}catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}}/>} 
    {cashOperation&&<CashOperationModal type={cashOperation} onClose={()=>setCashOperation(null)} onComplete={async(amount,reason)=>{try{await window.raspechatkaPos.addCashOperation(cashOperation,amount,reason);setCashOperation(null);await refresh();setMessage('Операция с наличными сохранена')}catch(e){setMessage(String(e))}}}/>} 
    {customerOpen&&<CustomerModal selected={customer} onClose={()=>setCustomerOpen(false)} onSelect={chooseCustomer}/>}
    {manualDiscountOpen&&<ManualDiscountModal lines={pricedCart} rules={discountRules} clubPercent={customer?.discountPercent??0} reviewCount={reviewCount} current={manualDiscount} onClose={()=>setManualDiscountOpen(false)} onApply={(value)=>{setManualDiscount(value);setManualDiscountOpen(false)}}/>}
    {priceOverrideLine&&<PriceOverrideModal line={priceOverrideLine} minimumMinor={productById.get(priceOverrideLine.productId)?.minimumSalePriceMinor??0} onClose={()=>setPriceOverrideLine(null)} onApply={(price)=>{const product=productById.get(priceOverrideLine.productId)!;setCart((current)=>current.map((item)=>item.productId===priceOverrideLine.productId?{...item,unitPriceMinor:price,catalogUnitPriceMinor:item.catalogUnitPriceMinor??product.priceMinor}:item));setPriceOverrideLine(null)}}/>}
    {cashCountOpen&&<CashCountModal type={cashCountOpen} expectedMinor={summary.expectedCashMinor} onClose={()=>setCashCountOpen(null)} onComplete={async(lines)=>{try{const count=await window.raspechatkaPos.saveCashCount(cashCountOpen,lines);setCashCountOpen(null);await refresh();if(count.countType==='closing'){await closeShift()}else setMessage('Пересчёт сохранён. Расхождение: '+formatMoney(count.differenceMinor))}catch(e){setMessage(e instanceof Error?e.message:String(e))}}}/>} 
  </div>
}

export const cashierResetEmployeeId=(auth:CashierAuthState,selectedEmployeeId:string):string=>
  auth.status==='locked'?(auth.employee?.id||''):selectedEmployeeId

export const lockedCashierCanSwitch=(auth:CashierAuthState):boolean=>
  auth.status==='locked'&&!auth.openShiftCashierId&&!auth.openShiftCashierName

export async function runLockedCashierSwitch(
  logoutCashier:()=>Promise<unknown>,
  refresh:()=>Promise<void>,
):Promise<void>{
  await logoutCashier()
  await refresh()
}

export type CashierPinNoticeSeverity='error'|'success'
export const cashierPinNoticeClass=(severity:CashierPinNoticeSeverity)=>`cashier-login-notice cashier-login-${severity}`

export function CashierLogin({boot,auth,onAuthenticated}:{boot:BootState;auth:CashierAuthState;onAuthenticated:()=>Promise<void>}){
  const forced=auth.openShiftCashierId
  const [employeeId,setEmployeeId]=useState(forced||'')
  const [pin,setPin]=useState('')
  const [confirmation,setConfirmation]=useState('')
  const [setup,setSetup]=useState(false)
  const [adminReset,setAdminReset]=useState(false)
  const [adminCode,setAdminCode]=useState('')
  const [notice,setNotice]=useState<{severity:CashierPinNoticeSeverity;message:string}|null>(null)
  const selected=boot.employees.find((row)=>row.id===employeeId)||(forced===employeeId?{id:employeeId,name:auth.openShiftCashierName||employeeId}:undefined)
  const lockedEmployee=auth.employee
  const resetEmployeeId=cashierResetEmployeeId(auth,employeeId)
  const openWorkShift=Boolean(auth.openShiftCashierId||auth.openShiftCashierName)
  const canSwitchCashier=lockedCashierCanSwitch(auth)
  const choose=async(id:string)=>{setEmployeeId(id);setPin('');setConfirmation('');setNotice(null);if(id){try{setSetup((await window.raspechatkaPos.beginCashierLogin(id)).requiresPinSetup)}catch(e){setNotice({severity:'error',message:e instanceof Error?e.message:String(e)})}}}
  useEffect(()=>{if(forced)void choose(forced)},[forced])
  const submit=async()=>{try{
    if(auth.status==='locked')await window.raspechatkaPos.unlockCashier(pin)
    else if(setup)await window.raspechatkaPos.createCashierPin(employeeId,pin,confirmation)
    else await window.raspechatkaPos.loginCashier(employeeId,pin)
    await onAuthenticated()
  }catch(e){setNotice({severity:'error',message:e instanceof Error?e.message:String(e)});setPin('');setConfirmation('')}}
  const reset=async()=>{try{
    if(!resetEmployeeId)throw new Error('Не удалось определить кассира для сброса PIN')
    await window.raspechatkaPos.resetCashierPin(resetEmployeeId,adminCode,pin,confirmation)
    setAdminReset(false);setAdminCode('');setSetup(false);setNotice({severity:'success',message:'PIN изменён. Теперь войдите с новым PIN.'});setPin('');setConfirmation('')
  }catch(e){setNotice({severity:'error',message:e instanceof Error?e.message:String(e)})}}
  const switchCashier=async()=>{try{
    await runLockedCashierSwitch(
      ()=>window.raspechatkaPos.logoutCashier(),
      async()=>{
        setEmployeeId('');setPin('');setConfirmation('');setAdminReset(false);setAdminCode('');setSetup(false);setNotice(null)
        await onAuthenticated()
      },
    )
  }catch(e){setNotice({severity:'error',message:e instanceof Error?e.message:String(e)})}}
  const footerLeft=<PosButton className="settings-open-trigger" variant="quiet" type="button" icon={<PosIcon name="settings"/>}>Настройки кассы</PosButton>
  const footerRight=!setup&&!adminReset
    ?<PosButton className="cashier-forgot-pin" variant="quiet" type="button" onClick={()=>{setAdminReset(true);setPin('');setConfirmation('');setNotice(null)}}>Забыли PIN?</PosButton>
    :undefined
  return <main className="cashier-login-screen"><section className="cashier-login-card">
    {auth.status==='locked'&&<small>КАССА ЗАБЛОКИРОВАНА</small>}<h1>{auth.status==='locked'?formatPersonShortName(lockedEmployee?.name):'Выберите себя'}</h1>
    {forced&&<p>После перезапуска открытую смену может продолжить только <b>{formatPersonShortName(auth.openShiftCashierName)}</b>.</p>}
    {auth.status!=='locked'&&!forced&&<div className="cashier-list">{boot.employees.map((employee)=><button key={employee.id} className={employeeId===employee.id?'active':''} onClick={()=>void choose(employee.id)}>{formatPersonShortName(employee.name)}</button>)}</div>}
    {!boot.employees.length&&<p>Нет подтверждённых кассиров этой точки. Выполните синхронизацию в настройках.</p>}
    {(selected||lockedEmployee)&&<form className="cashier-pin-form" onSubmit={(event)=>{event.preventDefault();void (adminReset?reset():submit())}}>
      <PinEntryLayout footerLeft={footerLeft} footerRight={footerRight}>
        <div className="cashier-pin-fields">
          {adminReset&&<label><span>Код администратора</span><PinInput autoFocus value={adminCode} onChange={setAdminCode} ariaLabel="Код администратора · 4 цифры"/></label>}
          <label><span>{setup||adminReset?'Новый PIN · 4 цифры':'PIN кассира · 4 цифры'}</span><PinInput autoFocus={!adminReset} value={pin} onChange={setPin} ariaLabel={setup||adminReset?'Новый PIN · 4 цифры':'PIN кассира · 4 цифры'}/></label>
          {(setup||adminReset)&&<label><span>Повторите PIN</span><PinInput value={confirmation} onChange={setConfirmation} ariaLabel="Повторите PIN · 4 цифры"/></label>}
          {notice&&<div className={cashierPinNoticeClass(notice.severity)} role={notice.severity==='error'?'alert':'status'}>{notice.message}</div>}
          {(setup||adminReset)&&<PosButton className="cashier-pin-submit" variant="primary" size="touch" type="submit">{adminReset?'Сбросить PIN':'Создать PIN и войти'}</PosButton>}
          {auth.status==='locked'&&canSwitchCashier&&<PosButton className="cashier-switch-cashier" variant="secondary" size="touch" type="button" onClick={()=>void switchCashier()}>Сменить кассира</PosButton>}
          {auth.status==='locked'&&openWorkShift&&<p className="cashier-switch-blocked">Чтобы сменить кассира, разблокируйте текущего кассира и закройте смену.</p>}
        </div>
      </PinEntryLayout>
    </form>}
    {!(selected||lockedEmployee)&&auth.status!=='locked'&&<div className="cashier-login-footer"><PosButton className="settings-open-trigger" variant="quiet" type="button" icon={<PosIcon name="settings"/>}>Настройки кассы</PosButton></div>}
  </section></main>
}

export const isCompleteOrderPhone=(value:string)=>value.replace(/\D/g,'').length===11

function OrderModal({draft,total,onChange,onClose,onPay}:{draft:{phone:string;comment?:string;dueAt?:string};total:number;onChange:(draft:{phone:string;comment?:string;dueAt?:string})=>void;onClose:()=>void;onPay:()=>void}){
  const valid=isCompleteOrderPhone(draft.phone)&&Boolean(draft.comment?.trim())&&Boolean(draft.dueAt)
  return <PosModal open title="Оформить заказ" className="order-modal" onClose={onClose} footer={<PosButton variant="primary" size="touch" disabled={!valid||total<=0} onClick={onPay}>К оплате · {formatMoney(total)}</PosButton>}>
    <div className="order-form-compact">
      <PosField label="Телефон *" error={draft.phone&&!isCompleteOrderPhone(draft.phone)?'Введите полный номер из 11 цифр':undefined}><input autoFocus inputMode="tel" value={draft.phone} onChange={(e)=>onChange({...draft,phone:e.target.value})} placeholder="+7 900 000-00-00"/></PosField>
      <PosField label="Срок готовности *"><input type="datetime-local" value={draft.dueAt||''} onChange={(e)=>onChange({...draft,dueAt:e.target.value})}/></PosField>
      <PosField label="Описание заказа *" size="textarea" className="order-description-field"><textarea value={draft.comment||''} onChange={(e)=>onChange({...draft,comment:e.target.value})} placeholder="Что нужно изготовить"/></PosField>
    </div>
  </PosModal>
}

function ReturnModal({sale,busy,onClose,onComplete}:{sale:SaleDetails;busy:boolean;onClose:()=>void;onComplete:(lines:Array<{saleItemId:number;quantity:number}>,payments:PaymentPart[])=>Promise<void>}){
  const [quantities,setQuantities]=useState<Record<number,number>>({})
  const [method,setMethod]=useState<PaymentMethod>(sale.payments[0]?.method??'cash')
  const raw=sale.lines.reduce((sum,x)=>sum+Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent??0)/100)),0)||1
  const total=sale.lines.reduce((sum,x)=>{const paid=Math.round(sale.totalMinor*Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent??0)/100))/raw);return sum+Math.round(paid*(quantities[x.id]??0)/x.quantity)},0)
  const lines=Object.entries(quantities).filter(([,q])=>q>0).map(([id,quantity])=>({saleItemId:Number(id),quantity}))
  return <PosModal open title={'Возврат по чеку '+sale.receiptNumber} className="return-modal" layout="matrix" closeDisabled={busy} onClose={onClose} footer={<PosButton variant="primary" size="touch" disabled={busy||!lines.length||!total||method==='remote_payment'} onClick={()=>onComplete(lines,[{method,amountMinor:total}])}>{busy?'Оформляем…':'Оформить возврат · '+formatMoney(total)}</PosButton>}>
    <div className="return-lines">{sale.lines.map((x)=>{const available=x.quantity-x.returnedQuantity;return <article key={x.id}><div><b>{x.name}</b><small>Куплено {x.quantity}, ранее возвращено {x.returnedQuantity}</small></div><PosField label="Вернуть"><input type="number" min="0" max={available} step="1" value={quantities[x.id]??0} onChange={(e)=>setQuantities({...quantities,[x.id]:Math.min(available,Math.max(0,Number(e.target.value)))})}/></PosField></article>})}</div>
    <div className="refund-footer"><div><span>Вернуть клиенту</span><strong>{formatMoney(total)}</strong></div><PosField label="Способ возврата"><select value={method} onChange={(e)=>setMethod(e.target.value as PaymentMethod)}>{sale.payments.map((x)=><option key={x.method} value={x.method}>{paymentNames[x.method]||x.method}</option>)}</select></PosField></div>
    {method==='remote_payment'&&<div className="error-note">Автоматический возврат удалённой оплаты пока не подключён. Выберите другой согласованный способ возврата.</div>}
  </PosModal>
}

function CashOperationModal({type,onClose,onComplete}:{type:CashOperationType;onClose:()=>void;onComplete:(amount:number,reason:string)=>Promise<void>}){
  const [amount,setAmount]=useState('');const [reason,setReason]=useState('')
  return <PosModal open title={type==='deposit'?'Внесение':'Изъятие'} className="compact-modal" onClose={onClose} footer={<PosButton variant="primary" size="touch" disabled={toMinor(amount)<=0} onClick={()=>onComplete(toMinor(amount),reason)}>{type==='deposit'?'Внести':'Изъять'} · {formatMoney(toMinor(amount))}</PosButton>}>
    <div className="modal-field-stack"><PosField label="Сумма"><input autoFocus inputMode="decimal" value={amount} onChange={(e)=>setAmount(e.target.value)}/></PosField><PosField label="Основание"><input value={reason} onChange={(e)=>setReason(e.target.value)} placeholder={type==='deposit'?'Размен в начале смены':'Инкассация'}/></PosField></div>
  </PosModal>
}

function CustomerModal({selected,onClose,onSelect}:{selected:Customer|null;onClose:()=>void;onSelect:(value:Customer|null)=>void}){
  const [query,setQuery]=useState('')
  const [visible,setVisible]=useState<Customer[]>([])
  const [searching,setSearching]=useState(false)
  const digits=query.replace(/\D/g,'')
  useEffect(()=>{let cancelled=false;if(digits.length<4){setVisible([]);setSearching(false);return};const timer=window.setTimeout(async()=>{setSearching(true);try{const rows=await window.raspechatkaPos.listCustomers(digits);if(!cancelled)setVisible(rows)}finally{if(!cancelled)setSearching(false)}},120);return()=>{cancelled=true;window.clearTimeout(timer)}},[digits])
  const overflow=visible.length>50
  const rows=visible.slice(0,50)
  return <PosModal open title="Выбрать покупателя" className="customer-modal" layout="matrix" onClose={onClose}>
    <PosField label="Телефон" helper="Введите минимум 4 цифры"><input autoFocus inputMode="numeric" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Последние цифры телефона"/></PosField>
    <div className="customer-list"><PosButton className={!selected?'active':''} variant="quiet" onClick={()=>onSelect(null)}><span><b>Розничный покупатель</b><small>Без персональной скидки</small></span></PosButton>{overflow&&<div className="pilot-empty">Найдено слишком много клиентов. Введите ещё несколько цифр.</div>}{rows.map((x)=><PosButton key={x.id} className={selected?.id===x.id?'active':''} variant="quiet" onClick={()=>onSelect(x)}><span><b>{x.name}</b><small>{x.phone}</small></span><strong className="club-badge">Скидка {x.discountPercent}%</strong></PosButton>)}{!searching&&digits.length<4&&<div className="pilot-empty">Поиск выполняется только по телефону. Введите последние 4 цифры или больше.</div>}{!searching&&digits.length>=4&&!visible.length&&<div className="pilot-empty">В локальном кэше совпадений нет</div>}</div>
  </PosModal>
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
  return <PosModal open title="Дополнительная скидка" className="compact-modal" onClose={onClose} footer={<><PosButton variant="quiet" onClick={()=>onApply(null)}>Убрать скидку</PosButton><PosButton variant="primary" onClick={()=>onApply(draft)}>Применить</PosButton></>}>
    <div className="discount-type-actions"><PosButton className={type==='percent'?'active':''} onClick={()=>setType('percent')}>%</PosButton><PosButton className={type==='amount'?'active':''} onClick={()=>setType('amount')}>₽</PosButton></div>
    <PosField label={type==='percent'?'Процент':'Сумма, ₽'}><input autoFocus type="number" min="0" step={type==='amount'?'0.01':'0.1'} value={input} onChange={(event)=>setInput(event.target.value)}/></PosField>
    <div className="modal-summary">Будет применено: <b>{formatMoney(preview.manualDiscountMinor)}</b><br/>Новый итог: <b>{formatMoney(preview.totalMinor)}</b></div>
  </PosModal>
}

function PriceOverrideModal({line,minimumMinor,onClose,onApply}:{line:CartLine;minimumMinor:number;onClose:()=>void;onApply:(price:number)=>void}){
  const [input,setInput]=useState(String(line.unitPriceMinor/100))
  const price=toMinor(input)
  const valid=price>=minimumMinor
  return <PosModal open title="Изменить цену" className="compact-modal" onClose={onClose} footer={<PosButton variant="primary" size="touch" disabled={!valid} onClick={()=>onApply(price)}>Применить · {formatMoney(price)}</PosButton>}>
    <p className="modal-context-name">{line.name}</p><PosField label="Цена за единицу, ₽" error={!valid?'Минимальная цена: '+formatMoney(minimumMinor):undefined}><input autoFocus type="number" min={minimumMinor/100} step="0.01" value={input} onChange={(event)=>setInput(event.target.value)}/></PosField>
  </PosModal>
}

export const CASH_COUNT_DENOMINATIONS=[500000,100000,50000,10000,5000,1000,500,200,100] as const
export const buildCashCountLines=(quantities:Record<number,number>):CashCountLine[]=>
  CASH_COUNT_DENOMINATIONS.map((denominationMinor)=>({denominationMinor,quantity:quantities[denominationMinor]||0}))
export const cashCountTotal=(lines:CashCountLine[]):number=>
  lines.reduce((sum,line)=>sum+line.denominationMinor*line.quantity,0)

function CashCountModal({type,expectedMinor,onClose,onComplete}:{type:CashCount['countType'];expectedMinor:number;onClose:()=>void;onComplete:(lines:CashCountLine[])=>Promise<void>}){
  const [quantities,setQuantities]=useState<Record<number,number>>({})
  const lines=buildCashCountLines(quantities)
  const total=cashCountTotal(lines)
  const expected=type==='opening'?total:expectedMinor
  const difference=total-expected
  const title=type==='opening'?'Наличные на начало смены':type==='closing'?'Перед закрытием смены':'Контроль кассы'
  return <PosModal open title={title} className="cash-count-modal" layout="matrix" onClose={onClose} footer={<PosButton variant="primary" size="touch" onClick={()=>onComplete(lines)}>Сохранить пересчёт{type==='closing'?' и закрыть смену':''}</PosButton>}>
    <div className="denominations">{CASH_COUNT_DENOMINATIONS.map((x)=><div className="denomination-row" key={x}><span className="denomination-badge">{formatMoney(x)}</span><PosField label="Количество"><input type="number" min="0" step="1" inputMode="numeric" aria-label={'Количество купюр или монет '+formatMoney(x)} value={quantities[x]||''} onChange={(e)=>setQuantities({...quantities,[x]:Math.max(0,Math.floor(Number(e.target.value)||0))})}/></PosField><b>{formatMoney(x*(quantities[x]||0))}</b></div>)}</div>
    <div className="cash-reconcile"><div><span>{type==='opening'?'Стартовый остаток':'Ожидается'}</span><b>{formatMoney(expected)}</b></div><div><span>Посчитано</span><b>{formatMoney(total)}</b></div><div className={difference===0?'match':'mismatch'}><span>Расхождение</span><strong>{formatMoney(difference)}</strong></div></div>
  </PosModal>
}

export const NAV_ICON_MAP:Record<Screen|'settings',PosIconName>={sale:'sale',receipts:'receipts',orders:'orders',shift:'shift',work:'work',settings:'settings'}
export function Nav({active,icon,label,badge,className='',onClick}:{active:boolean;icon:PosIconName;label:string;badge?:number;className?:string;onClick:()=>void}){return <PosButton variant="quiet" className={[active?'active':'',className].filter(Boolean).join(' ')} aria-current={active?'page':undefined} icon={<PosIcon name={icon}/>} onClick={onClick}>{label}{badge?<b>{badge}</b>:null}</PosButton>}
export function SettingsNavTrigger(){return <Nav active={false} icon={NAV_ICON_MAP.settings} label="Настройки" className="settings-open-trigger" onClick={()=>undefined}/>} 
function Page({title,children}:{title:string;kicker:string;children:React.ReactNode}){return <main className={title==='Текущая смена'?'page shift-page':'page'}><div className="page-heading"><div><h1>{title}</h1></div></div>{children}</main>}
function Metric({label,value}:{label:string;value:string}){return <article><small>{label}</small><strong>{value}</strong></article>}
function Empty({title,text}:{title:string;text:string}){return <div className="page-empty"><i><PosIcon name="plus"/></i><b>{title}</b><span>{text}</span></div>}
