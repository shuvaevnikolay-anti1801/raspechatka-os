import { useEffect, useMemo, useState } from 'react'
import { calculateSubtotalMinor, calculateTotalMinor } from '../../shared/cart'
import type { BootState, CartLine, ConnectionConfig, ConnectionStatus, Customer, HeldReceipt, PaymentMethod, Product, SaleSummary, ShiftSummary } from '../../shared/contracts'

type Screen='sale'|'orders'|'receipts'|'shift'|'settings'
const money=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2})
const formatMoney=(minor:number)=>money.format(minor/100)
const paymentNames:Record<PaymentMethod,string>={cash:'Наличные',card:'Карта',qr:'QR-код'}

export default function App(){
  const [boot,setBoot]=useState<BootState|null>(null)
  const [products,setProducts]=useState<Product[]>([])
  const [customers,setCustomers]=useState<Customer[]>([])
  const [sales,setSales]=useState<SaleSummary[]>([])
  const [held,setHeld]=useState<HeldReceipt[]>([])
  const [summary,setSummary]=useState<ShiftSummary>({receipts:0,revenueMinor:0,cashMinor:0,cardMinor:0,qrMinor:0})
  const [connection,setConnection]=useState<ConnectionStatus|null>(null)
  const [screen,setScreen]=useState<Screen>('sale')
  const [query,setQuery]=useState('')
  const [category,setCategory]=useState('Все')
  const [cart,setCart]=useState<CartLine[]>([])
  const [customer,setCustomer]=useState<Customer|null>(null)
  const [discount,setDiscount]=useState(0)
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [payment,setPayment]=useState<PaymentMethod|null>(null)
  const [cashReceived,setCashReceived]=useState('')

  const refresh=async()=>{
    const result=await Promise.all([
      window.raspechatkaPos.getBootState(),window.raspechatkaPos.listProducts(),
      window.raspechatkaPos.listCustomers(),window.raspechatkaPos.listSales(),
      window.raspechatkaPos.listHeldReceipts(),window.raspechatkaPos.getShiftSummary(),
      window.raspechatkaPos.getConnectionStatus()
    ])
    setBoot(result[0]);setProducts(result[1]);setCustomers(result[2]);setSales(result[3])
    setHeld(result[4]);setSummary(result[5]);setConnection(result[6])
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
  const closeShift=async()=>{const result=await window.raspechatkaPos.closeShift();await refresh();setMessage('Смена закрыта: '+result.receipts+' чеков на '+formatMoney(result.revenueMinor))}
  const holdReceipt=async()=>{
    if(!cart.length)return
    await window.raspechatkaPos.holdReceipt({label:customer?.name||'Чек на '+formatMoney(total),lines:cart,customer,discountPercent:discount})
    clear();await refresh();setMessage('Чек отложен')
  }
  const restoreReceipt=async(receipt:HeldReceipt)=>{
    setCart(receipt.lines);setCustomer(receipt.customer??null);setDiscount(receipt.discountPercent)
    await window.raspechatkaPos.deleteHeldReceipt(receipt.id);await refresh();setScreen('sale')
  }
  const complete=async()=>{
    if(!payment||busy)return
    setBusy(true)
    try{
      const received=Math.round(Number(cashReceived.replace(',','.'))*100)
      const result=await window.raspechatkaPos.completeSale({
        clientRequestId:crypto.randomUUID(),paymentMethod:payment,lines:cart,customer,
        receiptDiscountPercent:allowedDiscount,cashReceivedMinor:payment==='cash'?(received||total):undefined
      })
      clear();setPayment(null);setCashReceived('');await refresh()
      setMessage('Чек '+result.receiptNumber+' готов'+(result.changeMinor?'. Сдача: '+formatMoney(result.changeMinor):''))
    }catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
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
      <aside className="categories"><strong>Категории</strong>
        {categories.map((name)=><button key={name} className={category===name?'active':''} onClick={()=>setCategory(name)}>{name}<span>{name==='Все'?products.length:products.filter((p)=>p.category===name).length}</span></button>)}
      </aside>
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
    {screen==='receipts'&&<Page title="Чеки и отложенные продажи" kicker="ИСТОРИЯ">
      {held.length>0&&<section className="held"><h3>Отложенные</h3>{held.map((r)=><article key={r.id}><div><b>{r.label}</b><small>{r.lines.length} поз. · {new Date(r.createdAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</small></div><button onClick={()=>restoreReceipt(r)}>Продолжить</button></article>)}</section>}
      <div className="data-table"><header><span>Чек</span><span>Дата</span><span>Покупатель</span><span>Оплата</span><span>Сумма</span></header>
      {sales.length?sales.map((s)=><div key={s.id}><b>{s.receiptNumber}</b><span>{new Date(s.createdAt).toLocaleString('ru-RU')}</span><span>{s.customerName||'Розничный покупатель'}</span><span>{paymentNames[s.paymentMethod]}</span><strong>{formatMoney(s.totalMinor)}</strong></div>):<Empty title="Продаж пока нет" text="После первого тестового чека здесь появится история."/>}</div>
    </Page>}
    {screen==='shift'&&<Page title="Текущая смена" kicker={boot.shift?'СМЕНА ОТКРЫТА':'СМЕНА ЗАКРЫТА'}>
      <div className="metrics"><Metric label="Выручка" value={formatMoney(summary.revenueMinor)}/><Metric label="Чеков" value={String(summary.receipts)}/><Metric label="Средний чек" value={formatMoney(summary.receipts?summary.revenueMinor/summary.receipts:0)}/><Metric label="К отправке" value={String(boot.pendingSync)}/></div>
      <section className="shift-card"><div><small>КАССИР</small><h2>{boot.cashierName}</h2><p>{boot.shift?'Начало: '+new Date(boot.shift.openedAt).toLocaleString('ru-RU'):'Откройте смену, чтобы проводить продажи'}</p></div>{boot.shift?<button className="danger" onClick={closeShift}>Закрыть смену</button>:<button className="primary" onClick={openShift}>Открыть смену</button>}</section>
    </Page>}
    {screen==='settings'&&<Settings boot={boot} connection={connection} onSaved={refresh} onSynced={async()=>{await refresh();setMessage('Каталог и настройки точки обновлены')}}/>}

    {payment&&<div className="modal-backdrop"><div className="payment-modal">
      <header><div><small>ОПЛАТА</small><h2>{formatMoney(total)}</h2></div><button onClick={()=>setPayment(null)}>×</button></header>
      <div className="method-grid">{boot.rules.acceptsCash&&<button className={payment==='cash'?'active':''} onClick={()=>setPayment('cash')}>Наличные</button>}{boot.rules.acceptsCard&&<button className={payment==='card'?'active':''} onClick={()=>setPayment('card')}>Банковская карта</button>}{boot.rules.acceptsQr&&<button className={payment==='qr'?'active':''} onClick={()=>setPayment('qr')}>QR-код</button>}</div>
      {payment==='cash'&&<label className="cash-input"><span>Получено от клиента</span><input autoFocus value={cashReceived} onChange={(e)=>setCashReceived(e.target.value)} placeholder={(total/100).toFixed(2)}/><small>Сдача: {formatMoney(Math.max(0,Math.round(Number(cashReceived.replace(',','.'))*100)-total))}</small></label>}
      <button className="primary confirm" disabled={busy} onClick={complete}>{busy?'Проводим…':'Подтвердить · '+formatMoney(total)}</button><p>ККТ и терминал работают в тестовом режиме</p>
    </div></div>}
  </div>
}

function Nav({active,icon,label,badge,onClick}:{active:boolean;icon:string;label:string;badge?:number;onClick:()=>void}){return <button className={active?'active':''} onClick={onClick}><i>{icon}</i>{label}{badge?<b>{badge}</b>:null}</button>}
function Page({title,kicker,children}:{title:string;kicker:string;children:React.ReactNode}){return <main className="page"><div className="page-heading"><div><small>{kicker}</small><h1>{title}</h1></div></div>{children}</main>}
function Metric({label,value}:{label:string;value:string}){return <article><small>{label}</small><strong>{value}</strong></article>}
function Empty({title,text}:{title:string;text:string}){return <div className="page-empty"><i>＋</i><b>{title}</b><span>{text}</span></div>}

function Settings({boot,connection,onSaved,onSynced}:{boot:BootState;connection:ConnectionStatus|null;onSaved:()=>Promise<void>;onSynced:()=>Promise<void>}){
  const [form,setForm]=useState<ConnectionConfig>({serverUrl:connection?.serverUrl||'http://raspechatka.localhost:8000',apiKey:'',apiSecret:'',workplaceCode:connection?.workplaceCode||''})
  const [status,setStatus]=useState('')
  const save=async()=>{try{await window.raspechatkaPos.saveConnection(form);await onSaved();setStatus('Подключение сохранено в защищённом хранилище Windows')}catch(e){setStatus(String(e))}}
  const sync=async()=>{try{setStatus('Подключаемся к OS…');await window.raspechatkaPos.syncNow();await onSynced();setStatus('Синхронизация завершена')}catch(e){setStatus(e instanceof Error?e.message:String(e))}}
  return <Page title="Настройки кассы" kicker="ПОДКЛЮЧЕНИЕ"><div className="settings-grid">
    <section className="settings-card"><h2>Распечатка OS</h2><p>Касса получает из центральной системы сотрудника, точку, доступный ассортимент и локальные цены.</p>
      <label>Адрес OS<input value={form.serverUrl} onChange={(e)=>setForm({...form,serverUrl:e.target.value})}/></label>
      <div className="form-row"><label>API key<input value={form.apiKey} onChange={(e)=>setForm({...form,apiKey:e.target.value})}/></label><label>API secret<input type="password" value={form.apiSecret} onChange={(e)=>setForm({...form,apiSecret:e.target.value})}/></label></div>
      <label>Код рабочего места<input value={form.workplaceCode} onChange={(e)=>setForm({...form,workplaceCode:e.target.value})} placeholder="Можно оставить пустым, если касса одна"/></label>
      {status&&<div className="settings-status">{status}</div>}<div className="settings-actions"><button onClick={save}>Сохранить</button><button className="primary" disabled={!connection?.configured} onClick={sync}>Синхронизировать</button></div>
    </section>
    <section className="settings-card"><h2>Состояние</h2><dl><div><dt>Режим</dt><dd>{boot.source==='frappe'?'Данные из OS':'Демо-данные'}</dd></div><div><dt>Точка</dt><dd>{boot.pointName}</dd></div><div><dt>Последнее обновление</dt><dd>{boot.lastSyncAt?new Date(boot.lastSyncAt).toLocaleString('ru-RU'):'Ещё не было'}</dd></div><div><dt>Очередь</dt><dd>{boot.pendingSync} операций</dd></div></dl>{connection?.lastError&&<div className="error-note">{connection.lastError}</div>}</section>
  </div></Page>
}
