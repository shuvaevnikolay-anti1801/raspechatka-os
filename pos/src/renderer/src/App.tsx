import { useEffect, useMemo, useState } from 'react'
import { calculateSubtotalMinor, calculateTotalMinor } from '../../shared/cart'
import type {
  BootState, CartLine, CashOperation, CashOperationType, ConnectionConfig, ConnectionStatus,
  Customer, HeldReceipt, PaymentMethod, PaymentPart, Product, ReturnSummary, SaleDetails,
  SalePaymentMethod, SaleSummary, ShiftSummary
} from '../../shared/contracts'

type Screen='sale'|'orders'|'receipts'|'shift'|'settings'
type PaymentChoice=PaymentMethod|'mixed'
const money=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2})
const formatMoney=(minor:number)=>money.format(minor/100)
const toMinor=(value:string)=>Math.round((Number(value.replace(',','.'))||0)*100)
const paymentNames:Record<SalePaymentMethod,string>={cash:'Наличные',card:'Карта',qr:'QR-код',mixed:'Смешанная'}
const emptySummary:ShiftSummary={receipts:0,revenueMinor:0,returnsMinor:0,cashMinor:0,cardMinor:0,qrMinor:0,depositsMinor:0,withdrawalsMinor:0,expectedCashMinor:0}

export default function App(){
  const [boot,setBoot]=useState<BootState|null>(null)
  const [products,setProducts]=useState<Product[]>([])
  const [customers,setCustomers]=useState<Customer[]>([])
  const [sales,setSales]=useState<SaleSummary[]>([])
  const [returns,setReturns]=useState<ReturnSummary[]>([])
  const [held,setHeld]=useState<HeldReceipt[]>([])
  const [cashOperations,setCashOperations]=useState<CashOperation[]>([])
  const [summary,setSummary]=useState<ShiftSummary>(emptySummary)
  const [connection,setConnection]=useState<ConnectionStatus|null>(null)
  const [screen,setScreen]=useState<Screen>('sale')
  const [query,setQuery]=useState('')
  const [category,setCategory]=useState('Все')
  const [cart,setCart]=useState<CartLine[]>([])
  const [customer,setCustomer]=useState<Customer|null>(null)
  const [discount,setDiscount]=useState(0)
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [payment,setPayment]=useState<PaymentChoice|null>(null)
  const [returnSale,setReturnSale]=useState<SaleDetails|null>(null)
  const [cashOperation,setCashOperation]=useState<CashOperationType|null>(null)

  const refresh=async()=>{
    const result=await Promise.all([
      window.raspechatkaPos.getBootState(),window.raspechatkaPos.listProducts(),
      window.raspechatkaPos.listCustomers(),window.raspechatkaPos.listSales(),
      window.raspechatkaPos.listReturns(),window.raspechatkaPos.listHeldReceipts(),
      window.raspechatkaPos.getShiftSummary(),window.raspechatkaPos.listCashOperations(),
      window.raspechatkaPos.getConnectionStatus()
    ])
    setBoot(result[0]);setProducts(result[1]);setCustomers(result[2]);setSales(result[3])
    setReturns(result[4]);setHeld(result[5]);setSummary(result[6]);setCashOperations(result[7]);setConnection(result[8])
  }
  useEffect(()=>{refresh().catch((e)=>setMessage(String(e)))},[])

  const categories=useMemo(()=>['Все',...new Set(products.map((p)=>p.category))],[products])
  const visible=useMemo(()=>{
    const text=query.trim().toLocaleLowerCase('ru')
    return products.filter((p)=>(category==='Все'||p.category===category)&&(!text||(p.name+' '+p.sku+' '+(p.barcode||'')).toLocaleLowerCase('ru').includes(text)))
  },[products,query,category])
  const subtotal=calculateSubtotalMinor(cart)
  const allowedDiscount=boot?.rules.allowDiscounts?Math.min(discount,boot.rules.maxDiscountPercent):0
  const total=calculateTotalMinor(cart,allowedDiscount)

  const add=(product:Product)=>setCart((current)=>{
    const found=current.find((line)=>line.productId===product.id)
    return found?current.map((line)=>line.productId===product.id?{...line,quantity:line.quantity+1}:line):[...current,{productId:product.id,name:product.name,quantity:1,unitPriceMinor:product.priceMinor}]
  })
  const change=(id:string,delta:number)=>setCart((current)=>current.map((line)=>line.productId===id?{...line,quantity:Math.round((line.quantity+delta)*1000)/1000}:line).filter((line)=>line.quantity>0))
  const clear=()=>{setCart([]);setCustomer(null);setDiscount(0)}
  const openShift=async()=>{await window.raspechatkaPos.openShift();await refresh();setMessage('Смена открыта')}
  const closeShift=async()=>{const x=await window.raspechatkaPos.closeShift();await refresh();setMessage('Смена закрыта: '+x.receipts+' чеков, итог '+formatMoney(x.revenueMinor-x.returnsMinor))}
  const holdReceipt=async()=>{
    if(!cart.length)return
    await window.raspechatkaPos.holdReceipt({label:customer?.name||'Чек на '+formatMoney(total),lines:cart,customer,discountPercent:discount})
    clear();await refresh();setMessage('Чек отложен')
  }
  const restoreReceipt=async(receipt:HeldReceipt)=>{
    setCart(receipt.lines);setCustomer(receipt.customer??null);setDiscount(receipt.discountPercent)
    await window.raspechatkaPos.deleteHeldReceipt(receipt.id);await refresh();setScreen('sale')
  }
  const complete=async(payments:PaymentPart[],cashReceivedMinor?:number)=>{
    if(busy)return
    setBusy(true)
    try{
      const result=await window.raspechatkaPos.completeSale({
        clientRequestId:crypto.randomUUID(),payments,lines:cart,customer,
        receiptDiscountPercent:allowedDiscount,cashReceivedMinor
      })
      clear();setPayment(null);await refresh()
      setMessage('Чек '+result.receiptNumber+' готов'+(result.changeMinor?'. Сдача: '+formatMoney(result.changeMinor):''))
    }catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  const startReturn=async(sale:SaleSummary)=>{
    if(!boot?.shift){setMessage('Для возврата сначала откройте смену');return}
    try{setReturnSale(await window.raspechatkaPos.getSale(sale.id))}catch(e){setMessage(String(e))}
  }

  if(!boot)return <div className="loading"><i/>Запускаем кассу…</div>
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">Р</div><strong>Распечатка <b>OS</b></strong><span>Касса</span></div>
      <div className="point"><small>{boot.pointName}</small><b>{boot.workstationName}</b></div>
      <div className="top-status"><span className={boot.online?'online':'offline'}><i/>{boot.online?'OS на связи':'Локальный режим'}</span><button onClick={()=>setScreen('settings')}>{boot.cashierName}</button></div>
    </header>
    <nav className="main-nav">
      <Nav active={screen==='sale'} icon="▣" label="Продажа" onClick={()=>setScreen('sale')}/>
      <Nav active={screen==='orders'} icon="▤" label="Заказы" onClick={()=>setScreen('orders')}/>
      <Nav active={screen==='receipts'} icon="⌁" label="Чеки" badge={held.length} onClick={()=>setScreen('receipts')}/>
      <Nav active={screen==='shift'} icon="◷" label="Смена" onClick={()=>setScreen('shift')}/>
      <Nav active={screen==='settings'} icon="⚙" label="Настройки" onClick={()=>setScreen('settings')}/>
      <div className="nav-spacer"/><span className="sync-state">К отправке: <b>{boot.pendingSync}</b></span>
    </nav>
    {message&&<div className="toast" onClick={()=>setMessage('')}>{message}<button>×</button></div>}

    {screen==='sale'&&<main className="sale-layout">
      <aside className="categories"><strong>Категории</strong>{categories.map((name)=><button key={name} className={category===name?'active':''} onClick={()=>setCategory(name)}>{name}<span>{name==='Все'?products.length:products.filter((p)=>p.category===name).length}</span></button>)}</aside>
      <section className="catalog">
        <div className="catalog-toolbar"><label className="search"><span>⌕</span><input autoFocus value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Товар, услуга, артикул или штрихкод"/><kbd>F2</kbd></label><button className="secondary">Свободная цена</button></div>
        <div className="product-grid">{visible.map((p)=><button className="product-card" key={p.id} onClick={()=>add(p)}>
          <span className={'type '+p.type}>{p.type==='service'?'Услуга':p.type==='bundle'?'Комплект':'Товар'}</span>
          <strong>{p.name}</strong><small>{p.sku} · {p.uom}</small>
          <footer><b>{formatMoney(p.priceMinor)}</b>{p.stock!=null&&<span>Остаток {p.stock}</span>}</footer>
        </button>)}</div>
      </section>
      <aside className="receipt">
        <header><div><small>ТЕКУЩАЯ ПРОДАЖА</small><h2>Новый чек</h2></div><button disabled={!cart.length} onClick={clear}>Очистить</button></header>
        <div className="customer-row"><button onClick={()=>setCustomer(customer?null:customers.find((c)=>c.id!=='retail')??null)}>◎ {customer?.name||'Добавить покупателя'}</button>{customer&&<span>Скидка клиента {customer.discountPercent}%</span>}</div>
        <div className="receipt-lines">{!cart.length?<div className="empty"><i>＋</i><b>Чек пока пуст</b><span>Выберите услугу или найдите её по названию</span></div>:cart.map((line)=><div className="receipt-line" key={line.productId}>
          <div><strong>{line.name}</strong><small>{formatMoney(line.unitPriceMinor)} за ед.</small></div>
          <div className="qty"><button onClick={()=>change(line.productId,-1)}>−</button><b>{line.quantity}</b><button onClick={()=>change(line.productId,1)}>+</button></div>
          <b>{formatMoney(line.quantity*line.unitPriceMinor)}</b>
        </div>)}</div>
        <footer className="receipt-total">
          <div className="discount-row"><span>Скидка на чек</span><label><input type="number" min="0" max={boot.rules.maxDiscountPercent} disabled={!boot.rules.allowDiscounts} value={discount} onChange={(e)=>setDiscount(Number(e.target.value))}/>%</label></div>
          {discount>0&&<div className="subtotal"><span>Без скидки</span><s>{formatMoney(subtotal)}</s></div>}
          <div className="total"><span>Итого</span><strong>{formatMoney(total)}</strong></div>
          {!boot.shift?<button className="primary wide" onClick={openShift}>Открыть смену</button>:<>
            <div className="receipt-actions"><button disabled={!cart.length} onClick={holdReceipt}>Отложить</button><button className="primary" disabled={!cart.length} onClick={()=>setPayment(boot.rules.acceptsCard?'card':'cash')}>К оплате</button></div>
            <small className="training">Учебный режим оборудования · деньги не списываются</small>
          </>}
        </footer>
      </aside>
    </main>}

    {screen==='orders'&&<Page title="Заказы" kicker="РАБОЧЕЕ МЕСТО"><div className="toolbar"><input placeholder="Номер, клиент или телефон"/><select><option>Все статусы</option><option>Новый</option><option>В работе</option><option>Готов</option></select><button className="primary">+ Новый заказ</button></div><Empty title="Заказы подключим к OS" text="Экран подготовлен для заказов точки, сроков готовности, оплаты и выдачи клиенту."/></Page>}
    {screen==='receipts'&&<Page title="Чеки и возвраты" kicker="ИСТОРИЯ">
      {held.length>0&&<section className="held"><h3>Отложенные</h3>{held.map((r)=><article key={r.id}><div><b>{r.label}</b><small>{r.lines.length} поз. · {new Date(r.createdAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</small></div><button onClick={()=>restoreReceipt(r)}>Продолжить</button></article>)}</section>}
      <div className="data-table receipts-table"><header><span>Чек</span><span>Дата</span><span>Покупатель</span><span>Оплата</span><span>Сумма</span><span/></header>
      {sales.length?sales.map((s)=><div key={s.id}><b>{s.receiptNumber}<small className={'sale-status '+s.status}>{s.status==='returned'?'Возвращён':s.status==='partially_returned'?'Частичный возврат':''}</small></b><span>{new Date(s.createdAt).toLocaleString('ru-RU')}</span><span>{s.customerName||'Розничный покупатель'}</span><span>{paymentNames[s.paymentMethod]}</span><strong>{formatMoney(s.totalMinor)}{s.returnedMinor>0&&<small> − {formatMoney(s.returnedMinor)}</small>}</strong><button disabled={s.status==='returned'} onClick={()=>startReturn(s)}>Возврат</button></div>):<Empty title="Продаж пока нет" text="После первого тестового чека здесь появится история."/>}</div>
      {returns.length>0&&<section className="return-history"><h3>Оформленные возвраты</h3>{returns.map((x)=><article key={x.id}><div><b>{x.receiptNumber}</b><small>к чеку {x.originalReceiptNumber} · {new Date(x.createdAt).toLocaleString('ru-RU')}</small></div><strong>− {formatMoney(x.totalMinor)}</strong></article>)}</section>}
    </Page>}
    {screen==='shift'&&<Page title="Текущая смена" kicker={boot.shift?'СМЕНА ОТКРЫТА':'СМЕНА ЗАКРЫТА'}>
      <div className="metrics"><Metric label="Продажи" value={formatMoney(summary.revenueMinor)}/><Metric label="Возвраты" value={'− '+formatMoney(summary.returnsMinor)}/><Metric label="В кассе ожидается" value={formatMoney(summary.expectedCashMinor)}/><Metric label="Чеков" value={String(summary.receipts)}/></div>
      <section className="shift-card"><div><small>КАССИР</small><h2>{boot.cashierName}</h2><p>{boot.shift?'Начало: '+new Date(boot.shift.openedAt).toLocaleString('ru-RU'):'Откройте смену, чтобы проводить продажи'}</p></div>{boot.shift?<div className="shift-actions"><button onClick={()=>setCashOperation('deposit')}>Внести деньги</button><button onClick={()=>setCashOperation('withdrawal')}>Изъять деньги</button><button className="danger" onClick={closeShift}>Закрыть смену</button></div>:<button className="primary" onClick={openShift}>Открыть смену</button>}</section>
      {boot.shift&&<div className="shift-details"><section><h3>Оплаты</h3><dl><div><dt>Наличные продажи</dt><dd>{formatMoney(summary.cashMinor)}</dd></div><div><dt>Карта</dt><dd>{formatMoney(summary.cardMinor)}</dd></div><div><dt>QR</dt><dd>{formatMoney(summary.qrMinor)}</dd></div><div><dt>Внесения</dt><dd>{formatMoney(summary.depositsMinor)}</dd></div><div><dt>Изъятия</dt><dd>− {formatMoney(summary.withdrawalsMinor)}</dd></div></dl></section><section><h3>Движения наличных</h3>{cashOperations.length?cashOperations.map((x)=><article key={x.id}><div><b>{x.type==='deposit'?'Внесение':'Изъятие'}</b><small>{x.reason} · {new Date(x.createdAt).toLocaleTimeString('ru-RU')}</small></div><strong>{x.type==='deposit'?'+':'−'} {formatMoney(x.amountMinor)}</strong></article>):<p>Операций пока нет</p>}</section></div>}
    </Page>}
    {screen==='settings'&&<Settings boot={boot} connection={connection} onSaved={refresh} onSynced={async()=>{await refresh();setMessage('Каталог, настройки и очередь операций синхронизированы')}}/>}

    {payment&&<PaymentModal choice={payment} total={total} rules={boot.rules} busy={busy} onChoice={setPayment} onClose={()=>setPayment(null)} onComplete={complete}/>}
    {returnSale&&<ReturnModal sale={returnSale} busy={busy} onClose={()=>setReturnSale(null)} onComplete={async(lines,payments)=>{
      setBusy(true);try{const x=await window.raspechatkaPos.createReturn({clientRequestId:crypto.randomUUID(),saleId:returnSale.id,lines,payments});setReturnSale(null);await refresh();setMessage('Возврат '+x.receiptNumber+' оформлен на '+formatMoney(x.totalMinor))}catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
    }}/>}
    {cashOperation&&<CashOperationModal type={cashOperation} onClose={()=>setCashOperation(null)} onComplete={async(amount,reason)=>{try{await window.raspechatkaPos.addCashOperation(cashOperation,amount,reason);setCashOperation(null);await refresh();setMessage('Операция с наличными сохранена')}catch(e){setMessage(String(e))}}}/>}
  </div>
}

function PaymentModal({choice,total,rules,busy,onChoice,onClose,onComplete}:{choice:PaymentChoice;total:number;rules:BootState['rules'];busy:boolean;onChoice:(x:PaymentChoice)=>void;onClose:()=>void;onComplete:(payments:PaymentPart[],cashReceived?:number)=>Promise<void>}){
  const [cash,setCash]=useState('')
  const [card,setCard]=useState('')
  const cashMinor=toMinor(cash)
  const cardMinor=toMinor(card)
  const mixedRemainder=Math.max(0,total-cashMinor-cardMinor)
  const submit=()=>{
    if(choice==='mixed'){
      const parts:PaymentPart[]=[]
      if(cashMinor)parts.push({method:'cash',amountMinor:cashMinor})
      if(cardMinor)parts.push({method:'card',amountMinor:cardMinor})
      if(mixedRemainder&&rules.acceptsQr)parts.push({method:'qr',amountMinor:mixedRemainder})
      return onComplete(parts,cashMinor)
    }
    return onComplete([{method:choice,amountMinor:total}],choice==='cash'?(cashMinor||total):undefined)
  }
  const mixedValid=choice!=='mixed'||(cashMinor+cardMinor+(rules.acceptsQr?mixedRemainder:0)===total&&cashMinor+cardMinor<=total&&(cashMinor>0||cardMinor>0||mixedRemainder>0))
  return <div className="modal-backdrop"><div className="payment-modal">
    <header><div><small>ОПЛАТА</small><h2>{formatMoney(total)}</h2></div><button onClick={onClose}>×</button></header>
    <div className="method-grid">{rules.acceptsCash&&<button className={choice==='cash'?'active':''} onClick={()=>onChoice('cash')}>Наличные</button>}{rules.acceptsCard&&<button className={choice==='card'?'active':''} onClick={()=>onChoice('card')}>Банковская карта</button>}{rules.acceptsQr&&<button className={choice==='qr'?'active':''} onClick={()=>onChoice('qr')}>QR-код</button>}<button className={choice==='mixed'?'active':''} onClick={()=>onChoice('mixed')}>Смешанная</button></div>
    {choice==='cash'&&<label className="cash-input"><span>Получено от клиента</span><input autoFocus value={cash} onChange={(e)=>setCash(e.target.value)} placeholder={(total/100).toFixed(2)}/><small>Сдача: {formatMoney(Math.max(0,cashMinor-total))}</small></label>}
    {choice==='mixed'&&<div className="split-payment"><p>Укажите, сколько клиент платит каждым способом.</p>{rules.acceptsCash&&<label><span>Наличными</span><input value={cash} onChange={(e)=>setCash(e.target.value)}/></label>}{rules.acceptsCard&&<label><span>Картой</span><input value={card} onChange={(e)=>setCard(e.target.value)}/></label>}{rules.acceptsQr&&<div><span>QR — остаток</span><b>{formatMoney(mixedRemainder)}</b></div>}<footer><span>Распределено</span><b>{formatMoney(cashMinor+cardMinor+(rules.acceptsQr?mixedRemainder:0))}</b></footer></div>}
    <button className="primary confirm" disabled={busy||!mixedValid} onClick={submit}>{busy?'Проводим…':'Подтвердить · '+formatMoney(total)}</button><p>ККТ и терминал работают в тестовом режиме</p>
  </div></div>
}

function ReturnModal({sale,busy,onClose,onComplete}:{sale:SaleDetails;busy:boolean;onClose:()=>void;onComplete:(lines:Array<{saleItemId:number;quantity:number}>,payments:PaymentPart[])=>Promise<void>}){
  const [quantities,setQuantities]=useState<Record<number,number>>({})
  const [method,setMethod]=useState<PaymentMethod>(sale.payments[0]?.method??'cash')
  const raw=sale.lines.reduce((sum,x)=>sum+Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent??0)/100)),0)||1
  const total=sale.lines.reduce((sum,x)=>{
    const paid=Math.round(sale.totalMinor*Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent??0)/100))/raw)
    return sum+Math.round(paid*(quantities[x.id]??0)/x.quantity)
  },0)
  const lines=Object.entries(quantities).filter(([,q])=>q>0).map(([id,quantity])=>({saleItemId:Number(id),quantity}))
  return <div className="modal-backdrop"><div className="payment-modal return-modal">
    <header><div><small>ВОЗВРАТ ПО ЧЕКУ</small><h2>{sale.receiptNumber}</h2></div><button onClick={onClose}>×</button></header>
    <div className="return-lines">{sale.lines.map((x)=>{const available=x.quantity-x.returnedQuantity;return <article key={x.id}><div><b>{x.name}</b><small>Куплено {x.quantity}, ранее возвращено {x.returnedQuantity}</small></div><label>Вернуть <input type="number" min="0" max={available} step="1" value={quantities[x.id]??0} onChange={(e)=>setQuantities({...quantities,[x.id]:Math.min(available,Math.max(0,Number(e.target.value)))})}/></label></article>})}</div>
    <div className="refund-footer"><div><span>Вернуть клиенту</span><strong>{formatMoney(total)}</strong></div><label>Способ возврата<select value={method} onChange={(e)=>setMethod(e.target.value as PaymentMethod)}>{sale.payments.map((x)=><option key={x.method} value={x.method}>{paymentNames[x.method]}</option>)}</select></label></div>
    <button className="primary confirm" disabled={busy||!lines.length||!total} onClick={()=>onComplete(lines,[{method,amountMinor:total}])}>{busy?'Оформляем…':'Оформить возврат · '+formatMoney(total)}</button>
  </div></div>
}

function CashOperationModal({type,onClose,onComplete}:{type:CashOperationType;onClose:()=>void;onComplete:(amount:number,reason:string)=>Promise<void>}){
  const [amount,setAmount]=useState('');const [reason,setReason]=useState('')
  return <div className="modal-backdrop"><div className="payment-modal compact-modal"><header><div><small>ДЕНЕЖНЫЙ ЯЩИК</small><h2>{type==='deposit'?'Внесение':'Изъятие'}</h2></div><button onClick={onClose}>×</button></header><label className="cash-input"><span>Сумма</span><input autoFocus value={amount} onChange={(e)=>setAmount(e.target.value)}/></label><label className="cash-input"><span>Основание</span><input value={reason} onChange={(e)=>setReason(e.target.value)} placeholder={type==='deposit'?'Размен в начале смены':'Инкассация'}/></label><button className="primary confirm" disabled={toMinor(amount)<=0} onClick={()=>onComplete(toMinor(amount),reason)}>{type==='deposit'?'Внести':'Изъять'} · {formatMoney(toMinor(amount))}</button></div></div>
}

function Nav({active,icon,label,badge,onClick}:{active:boolean;icon:string;label:string;badge?:number;onClick:()=>void}){return <button className={active?'active':''} onClick={onClick}><i>{icon}</i>{label}{badge?<b>{badge}</b>:null}</button>}
function Page({title,kicker,children}:{title:string;kicker:string;children:React.ReactNode}){return <main className="page"><div className="page-heading"><div><small>{kicker}</small><h1>{title}</h1></div></div>{children}</main>}
function Metric({label,value}:{label:string;value:string}){return <article><small>{label}</small><strong>{value}</strong></article>}
function Empty({title,text}:{title:string;text:string}){return <div className="page-empty"><i>＋</i><b>{title}</b><span>{text}</span></div>}

function Settings({boot,connection,onSaved,onSynced}:{boot:BootState;connection:ConnectionStatus|null;onSaved:()=>Promise<void>;onSynced:()=>Promise<void>}){
  const [form,setForm]=useState<ConnectionConfig>({serverUrl:connection?.serverUrl||'http://raspechatka.localhost:8000',apiKey:'',apiSecret:'',workplaceCode:connection?.workplaceCode||''})
  const [status,setStatus]=useState('')
  const save=async()=>{try{await window.raspechatkaPos.saveConnection(form);await onSaved();setStatus('Подключение сохранено в защищённом хранилище Windows')}catch(e){setStatus(String(e))}}
  const sync=async()=>{try{setStatus('Отправляем операции и обновляем каталог…');await window.raspechatkaPos.syncNow();await onSynced();setStatus('Синхронизация завершена')}catch(e){setStatus(e instanceof Error?e.message:String(e))}}
  return <Page title="Настройки кассы" kicker="ПОДКЛЮЧЕНИЕ"><div className="settings-grid">
    <section className="settings-card"><h2>Распечатка OS</h2><p>Касса получает сотрудника, точку, ассортимент и цены, а продажи и возвраты отправляет обратно.</p>
      <label>Адрес OS<input value={form.serverUrl} onChange={(e)=>setForm({...form,serverUrl:e.target.value})}/></label>
      <div className="form-row"><label>API key<input value={form.apiKey} onChange={(e)=>setForm({...form,apiKey:e.target.value})}/></label><label>API secret<input type="password" value={form.apiSecret} onChange={(e)=>setForm({...form,apiSecret:e.target.value})}/></label></div>
      <label>Код рабочего места<input value={form.workplaceCode} onChange={(e)=>setForm({...form,workplaceCode:e.target.value})} placeholder="Можно оставить пустым, если касса одна"/></label>
      {status&&<div className="settings-status">{status}</div>}<div className="settings-actions"><button onClick={save}>Сохранить</button><button className="primary" disabled={!connection?.configured} onClick={sync}>Синхронизировать</button></div>
    </section>
    <section className="settings-card"><h2>Состояние</h2><dl><div><dt>Режим</dt><dd>{boot.source==='frappe'?'Данные из OS':'Демо-данные'}</dd></div><div><dt>Точка</dt><dd>{boot.pointName}</dd></div><div><dt>Последнее обновление</dt><dd>{boot.lastSyncAt?new Date(boot.lastSyncAt).toLocaleString('ru-RU'):'Ещё не было'}</dd></div><div><dt>Очередь</dt><dd>{boot.pendingSync} операций</dd></div></dl>{connection?.lastError&&<div className="error-note">{connection.lastError}</div>}</section>
  </div></Page>
}
