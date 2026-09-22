import { PosButton } from './ui/PosButton'
import { PosModal } from './ui/PosModal'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  BootState,
  HeldReceipt,
  PaymentMethod,
  PointReceiptDetails,
  PointReceiptSummary,
  ReceiptSearchFilters,
  SaleDetails,
  SaleSummary,
} from '../../shared/contracts'
import { formatPersonShortName } from './person-name'
import { formatMoney } from './money'

const paymentNames:Record<string,string>={
  cash:'Наличные',
  card:'Карта',
  qr:'QR / СБП',
  remote_payment:'Безналичные',
  mixed:'Смешанная',
  Cash:'Наличные',
  Card:'Карта',
  QR:'QR / СБП',
}

const statusNames:Record<string,string>={
  completed:'Проведён',
  partially_returned:'Частичный возврат',
  returned:'Возвращён',
  Posted:'Проведён',
  Draft:'Черновик',
  Cancelled:'Отменён',
}

const periodLabels={
  current_shift:'Текущая смена',
  today:'Сегодня',
  yesterday:'Вчера',
  '7d':'7 дней',
  '30d':'30 дней',
  custom:'Период',
} as const

type Period=keyof typeof periodLabels
type DraftFilters={
  text:string
  period:Period
  dateFrom:string
  dateTo:string
  cashierId:string
  paymentChannel:''|'Cash'|'Noncash'
  amountMin:string
  amountMax:string
}
type DisplayRow={
  key:string
  summary:SaleSummary|PointReceiptSummary
  cached?:SaleSummary
  server?:PointReceiptSummary
}
type ReceiptDetail=
  | {kind:'cached';value:SaleDetails}
  | {kind:'server';value:PointReceiptDetails}

type Props={
  boot:BootState
  sales:SaleSummary[]
  held:HeldReceipt[]
  onReturn:(sale:SaleSummary)=>Promise<void>
  onRestore:(receipt:HeldReceipt)=>Promise<void>
  notify:(text:string)=>void
}

const emptyDraft=():DraftFilters=>({
  text:'',
  period:'current_shift',
  dateFrom:'',
  dateTo:'',
  cashierId:'',
  paymentChannel:'',
  amountMin:'',
  amountMax:'',
})

const toMinor=(value:string):number|undefined=>{
  if(!value.trim())return undefined
  const parsed=Number(value.replace(',','.'))
  return Number.isFinite(parsed)&&parsed>=0?Math.round(parsed*100):undefined
}

const methodsOf=(sale:SaleSummary):PaymentMethod[]=>{
  if(sale.paymentMethods?.length)return sale.paymentMethods
  return sale.paymentMethod==='mixed'?[]:[sale.paymentMethod as PaymentMethod]
}

const matchesPeriod=(sale:SaleSummary,filters:ReceiptSearchFilters,currentShiftId?:string)=>{
  if(filters.period==='current_shift')return Boolean(currentShiftId)&&sale.shiftId===currentShiftId
  const time=new Date(sale.createdAt).getTime()
  if(!Number.isFinite(time))return false
  const now=new Date()
  const todayStart=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime()
  if(filters.period==='today')return time>=todayStart
  if(filters.period==='yesterday')return time>=todayStart-86400000&&time<todayStart
  if(filters.period==='7d')return time>=todayStart-6*86400000
  if(filters.period==='30d')return time>=todayStart-29*86400000
  if(filters.period==='custom'){
    const from=filters.dateFrom?new Date(filters.dateFrom+'T00:00:00').getTime():Number.NEGATIVE_INFINITY
    const to=filters.dateTo?new Date(filters.dateTo+'T23:59:59.999').getTime():Number.POSITIVE_INFINITY
    return time>=from&&time<=to
  }
  return true
}

const filterLocal=(sales:SaleSummary[],query:string,filters:ReceiptSearchFilters,currentShiftId?:string)=>{
  const text=query.trim().toLocaleLowerCase('ru-RU')
  return sales.filter((sale)=>{
    if(!matchesPeriod(sale,filters,currentShiftId))return false
    if(filters.cashierId&&sale.cashierId!==filters.cashierId)return false
    if(filters.amountMinMinor!==undefined&&sale.totalMinor<filters.amountMinMinor)return false
    if(filters.amountMaxMinor!==undefined&&sale.totalMinor>filters.amountMaxMinor)return false
    if(filters.paymentChannel){
      const methods=methodsOf(sale)
      if(filters.paymentChannel==='Cash'&&!methods.includes('cash'))return false
      if(filters.paymentChannel==='Noncash'&&!methods.some((method)=>method!=='cash'))return false
    }
    if(text){
      const haystack=(sale.searchText||[
        sale.receiptNumber,sale.customerName,sale.customerPhone,sale.cashierName,
        paymentNames[sale.paymentMethod]||sale.paymentMethod,
      ].filter(Boolean).join(' ')).toLocaleLowerCase('ru-RU')
      if(!haystack.includes(text))return false
    }
    return true
  })
}

const heldTotal=(receipt:HeldReceipt)=>{
  if(receipt.totalMinor!==undefined)return receipt.totalMinor
  const gross=receipt.lines.reduce((sum,line)=>sum+Math.round(line.quantity*line.unitPriceMinor),0)
  return Math.max(0,Math.round(gross*(1-Math.min(100,Math.max(0,receipt.discountPercent||0))/100)))
}

const paymentLabelFromSale=(sale:SaleSummary)=>{
  const methods=methodsOf(sale)
  if(methods.length)return methods.map((method)=>paymentNames[method]||method).join(' + ')
  return paymentNames[sale.paymentMethod]||sale.paymentMethod
}

const asStatus=(value:string)=>statusNames[value]||value||'—'
const serverPaymentLabel=(value:string)=>value.split(' + ').map((part)=>paymentNames[part]||part).join(' + ')

export default function ReceiptsPage({boot,sales,held,onReturn,onRestore,notify}:Props){
  const [draft,setDraft]=useState<DraftFilters>(emptyDraft)
  const [applied,setApplied]=useState<ReceiptSearchFilters>({
    period:'current_shift',
    shiftExternalId:boot.shift?.id,
    receiptType:'Sale',
  })
  const [appliedQuery,setAppliedQuery]=useState('')
  const [rows,setRows]=useState<DisplayRow[]>([])
  const [source,setSource]=useState<'server'|'cache'>('cache')
  const [searching,setSearching]=useState(false)
  const [detail,setDetail]=useState<ReceiptDetail|null>(null)
  const [detailLoading,setDetailLoading]=useState(false)

  const cachedByIdentity=useMemo(()=>{
    const map=new Map<string,SaleSummary>()
    for(const sale of sales){
      map.set(sale.id,sale)
      if(sale.serverId)map.set('server:'+sale.serverId,sale)
    }
    return map
  },[sales])

  const localRows=(query:string,filters:ReceiptSearchFilters):DisplayRow[]=>
    filterLocal(sales,query,filters,boot.shift?.id).map((sale)=>({
      key:'local:'+sale.id,
      summary:sale,
      cached:sale,
    }))

  const serverRows=(found:PointReceiptSummary[]):DisplayRow[]=>
    found.map((receipt)=>{
      const cached=(receipt.externalId?cachedByIdentity.get(receipt.externalId):undefined)
        ||cachedByIdentity.get('server:'+receipt.id)
      return {
        key:'server:'+receipt.id,
        summary:receipt,
        cached,
        server:receipt,
      }
    })

  const runSearch=async(query:string,filters:ReceiptSearchFilters)=>{
    setSearching(true)
    try{
      const remote=serverRows(await window.raspechatkaPos.searchPointReceipts(query,filters))
      const representedLocalIds=new Set(
        remote.map((row)=>row.cached?.source==='local'?row.cached.id:undefined).filter(Boolean)
      )
      const unsyncedLocal=localRows(query,filters).filter(
        (row)=>row.cached?.source==='local'&&!representedLocalIds.has(row.cached.id)
      )
      setRows([...unsyncedLocal,...remote].sort((a,b)=>b.summary.createdAt.localeCompare(a.summary.createdAt)))
      setSource('server')
    }catch{
      setRows(localRows(query,filters))
      setSource('cache')
    }finally{
      setSearching(false)
    }
  }

  useEffect(()=>{
    const filters:ReceiptSearchFilters={
      period:'current_shift',
      shiftExternalId:boot.shift?.id,
      receiptType:'Sale',
    }
    setApplied(filters)
    setAppliedQuery('')
    setDraft(emptyDraft())
    void runSearch('',filters)
    // A shift change defines a new default receipt scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[boot.shift?.id])

  useEffect(()=>{
    if(source==='cache')setRows(localRows(appliedQuery,applied))
    // Keep offline results fresh after a local sale/return/sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[sales])

  const buildFilters=(value:DraftFilters):ReceiptSearchFilters=>({
    period:value.period,
    shiftExternalId:value.period==='current_shift'?boot.shift?.id:undefined,
    dateFrom:value.period==='custom'&&value.dateFrom?value.dateFrom:undefined,
    dateTo:value.period==='custom'&&value.dateTo?value.dateTo:undefined,
    cashierId:value.cashierId||undefined,
    amountMinMinor:toMinor(value.amountMin),
    amountMaxMinor:toMinor(value.amountMax),
    paymentChannel:value.paymentChannel,
    receiptType:'Sale',
  })

  const apply=()=>{
    const filters=buildFilters(draft)
    if(filters.amountMinMinor!==undefined&&filters.amountMaxMinor!==undefined&&filters.amountMinMinor>filters.amountMaxMinor){
      notify('Сумма «от» не может быть больше суммы «до»')
      return
    }
    if(draft.period==='custom'&&draft.dateFrom&&draft.dateTo&&draft.dateFrom>draft.dateTo){
      notify('Дата «с» не может быть позже даты «по»')
      return
    }
    setApplied(filters)
    setAppliedQuery(draft.text)
    void runSearch(draft.text,filters)
  }

  const clear=()=>{
    const next=emptyDraft()
    const filters:ReceiptSearchFilters={
      period:'current_shift',
      shiftExternalId:boot.shift?.id,
      receiptType:'Sale',
    }
    setDraft(next)
    setApplied(filters)
    setAppliedQuery('')
    void runSearch('',filters)
  }

  const openDetails=async(row:DisplayRow)=>{
    setDetailLoading(true)
    try{
      if(row.cached?.source==='local'){
        setDetail({kind:'cached',value:await window.raspechatkaPos.getSale(row.cached.id)})
      }else if(row.server){
        setDetail({kind:'server',value:await window.raspechatkaPos.getPointReceipt(row.server.id)})
      }else if(row.cached){
        setDetail({kind:'cached',value:await window.raspechatkaPos.getSale(row.cached.id)})
      }
    }catch(error){
      notify(error instanceof Error?error.message:String(error))
    }finally{
      setDetailLoading(false)
    }
  }

  const printCommodity=async(row:DisplayRow)=>{
    try{
      const result=row.cached
        ?await window.raspechatkaPos.printSale(row.cached.id,'commodity')
        :row.server
          ?await window.raspechatkaPos.printPointReceiptCommodity(row.server.id)
          :undefined
      if(result)notify(result.message)
    }catch(error){
      notify(error instanceof Error?error.message:String(error))
    }
  }

  const printFiscalCopy=async(row:DisplayRow)=>{
    if(!row.cached||row.cached.source!=='local')return
    try{
      const result=await window.raspechatkaPos.printSale(row.cached.id,'fiscal-copy')
      notify(result.message)
    }catch(error){
      notify(error instanceof Error?error.message:String(error))
    }
  }

  const returnReceipt=async(row:DisplayRow)=>{
    if(!row.cached||row.cached.source!=='local')return
    await onReturn(row.cached)
  }

  return <main className="page records-page receipts-page">
    <div className="page-heading"><h1>Чеки</h1></div>

    <section className="receipt-search-page">
      <form onSubmit={(event)=>{event.preventDefault();apply()}}>
        <label className="receipt-search-input">
          <span aria-hidden="true">⌕</span>
          <input
            value={draft.text}
            onChange={(event)=>setDraft({...draft,text:event.target.value})}
            placeholder="Номер чека, покупатель, телефон или товар"
          />
        </label>

        <div className="receipt-periods" aria-label="Период">
          {(Object.keys(periodLabels) as Period[]).map((period)=>
            <button
              type="button"
              key={period}
              className={draft.period===period?'active':''}
              onClick={()=>setDraft({...draft,period})}
            >{periodLabels[period]}</button>
          )}
        </div>

        {draft.period==='custom'&&<div className="receipt-date-range">
          <label>Дата с<input type="date" value={draft.dateFrom} onChange={(event)=>setDraft({...draft,dateFrom:event.target.value})}/></label>
          <label>Дата по<input type="date" value={draft.dateTo} onChange={(event)=>setDraft({...draft,dateTo:event.target.value})}/></label>
        </div>}

        <div className="receipt-filter-grid">
          <label>Кассир
            <select value={draft.cashierId} onChange={(event)=>setDraft({...draft,cashierId:event.target.value})}>
              <option value="">Все кассиры</option>
              {boot.employees.map((employee)=><option key={employee.id} value={employee.id}>{formatPersonShortName(employee.name)}</option>)}
            </select>
          </label>
          <label>Оплата
            <select value={draft.paymentChannel} onChange={(event)=>setDraft({...draft,paymentChannel:event.target.value as DraftFilters['paymentChannel']})}>
              <option value="">Любая</option>
              <option value="Cash">Наличные</option>
              <option value="Noncash">Безналичные</option>
            </select>
          </label>
          <label>Сумма от, ₽
            <input inputMode="decimal" value={draft.amountMin} onChange={(event)=>setDraft({...draft,amountMin:event.target.value})}/>
          </label>
          <label>Сумма до, ₽
            <input inputMode="decimal" value={draft.amountMax} onChange={(event)=>setDraft({...draft,amountMax:event.target.value})}/>
          </label>
          <div className="receipt-filter-actions">
            <button type="button" disabled={searching} onClick={clear}>Очистить</button>
            <button type="submit" className="primary" disabled={searching}>{searching?'Ищем…':'Найти'}</button>
          </div>
        </div>
      </form>
    </section>

    {source==='cache'&&<div className="receipt-cache-note">
      <b>Локальный кэш</b>
      <span>Нет ответа от OS — поиск выполнен по сохранённым чекам этой точки.</span>
    </div>}

    {held.length>0&&<section className="held held-receipts">
      <h3>Отложенные чеки</h3>
      <div className="held-receipts-grid">
        {held.map((receipt)=><article key={receipt.id}>
          <div className="held-receipt-head">
            <div>
              <b>{receipt.customer?.name||receipt.label}</b>
              <small>{new Date(receipt.createdAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})} · {receipt.lines.length} поз.</small>
            </div>
            <strong>{formatMoney(heldTotal(receipt))}</strong>
          </div>
          <div className="held-receipt-lines">
            {receipt.lines.slice(0,4).map((line)=><span key={line.productId}>{line.name} × {line.quantity}</span>)}
            {receipt.lines.length>4&&<span>+ ещё {receipt.lines.length-4}</span>}
          </div>
          <PosButton variant="secondary" onClick={()=>void onRestore(receipt)}>Продолжить</PosButton>
        </article>)}
      </div>
    </section>}

    <section className="receipts-table-wrap">
      <div className="data-table receipts-table">
        <header>
          <span>Чек</span><span>Дата и время</span><span>Кассир</span><span>Покупатель</span>
          <span>Оплата</span><span>Сумма / статус</span><span>Действия</span>
        </header>
        {rows.length?rows.map((row)=>{
          const summary=row.summary
          const isServer='receiptType' in summary
          const local=row.cached?.source==='local'?row.cached:undefined
          const cashierName=summary.cashierName
          const customerName=summary.customerName||'Розничный покупатель'
          const paymentLabel=isServer?serverPaymentLabel(summary.paymentLabel):paymentLabelFromSale(summary)
          const copyReason=!local
            ?'Точная фискальная копия разрешена только для продажи, фискализированной этой POS на выбранной ККТ'
            :!/^\\d+$/.test(local.receiptNumber)
              ?'У чека нет подтверждённого числового номера фискального документа ФН'
              :undefined
          const returnReason=!local
            ?'Межкассовый возврат требует центрального резервирования и защиты от повторного возврата'
            :!boot.shift
              ?'Для возврата сначала откройте смену'
              :local.status==='returned'||local.returnable===false
                ?'Чек уже полностью возвращён'
                :undefined
          return <div className="receipt-result-row" key={row.key} role="button" tabIndex={0}
            onClick={()=>void openDetails(row)}
            onKeyDown={(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();void openDetails(row)}}}>
            <b>{summary.receiptNumber}</b>
            <span>{new Date(summary.createdAt).toLocaleString('ru-RU')}</span>
            <span>{cashierName?formatPersonShortName(cashierName):'—'}</span>
            <span>{customerName}</span>
            <span>{paymentLabel||'—'}</span>
            <strong>{formatMoney(summary.totalMinor)}<small>{asStatus(summary.status)}</small></strong>
            <div className="sale-actions" onClick={(event)=>event.stopPropagation()}>
              <PosButton variant="secondary" onClick={()=>void printCommodity(row)}>Товарный чек</PosButton>
              <PosButton variant="secondary" disabled={Boolean(copyReason)} title={copyReason||'Печать точной копии выбранного фискального документа'} onClick={()=>void printFiscalCopy(row)}>Копия чека</PosButton>
              <PosButton variant="danger" disabled={Boolean(returnReason)} title={returnReason||'Оформить возврат по этому чеку'} onClick={()=>void returnReceipt(row)}>Возврат</PosButton>
            </div>
          </div>
        }):<div className="page-empty">{searching?'Ищем чеки…':'Чеки не найдены'}</div>}
      </div>
    </section>

    {detailLoading&&<div className="receipt-detail-loading">Загружаем чек…</div>}
    {detail&&<ReceiptDetailModal detail={detail} onClose={()=>setDetail(null)}/>}
  </main>
}

function ReceiptDetailModal({detail,onClose}:{detail:ReceiptDetail;onClose:()=>void}){
  const value=detail.value
  const cached=detail.kind==='cached'?detail.value:undefined
  const server=detail.kind==='server'?detail.value:undefined
  const cashier=value.cashierName
  const phone=value.customerPhone
  const payments=cached
    ?cached.payments.map((payment)=>({label:paymentNames[payment.method]||payment.method,amountMinor:payment.amountMinor}))
    :server!.payments.map((payment)=>({label:paymentNames[payment.channel]||payment.channel,amountMinor:payment.amountMinor}))
  const lines=cached
    ?cached.lines.map((line)=>({
      key:String(line.id),name:line.name,quantity:line.quantity,unitPriceMinor:line.unitPriceMinor,
      lineTotalMinor:Math.round(line.quantity*line.unitPriceMinor*(1-(line.discountPercent??0)/100)),
      discountPercent:line.discountPercent??0,returnedQuantity:line.returnedQuantity,
    }))
    :server!.lines.map((line,index)=>({
      key:line.productId||String(index),name:line.name,quantity:line.quantity,unitPriceMinor:line.unitPriceMinor,
      lineTotalMinor:line.lineTotalMinor,discountPercent:line.discountPercent??0,returnedQuantity:line.returnedQuantity??0,
    }))
  const gross=lines.reduce((sum,line)=>sum+Math.round(line.quantity*line.unitPriceMinor),0)
  const discount=Math.max(0,gross-value.totalMinor)

  return <PosModal open title={`Чек ${value.receiptNumber}`} onClose={onClose} layout="matrix" className="receipt-detail-modal">
      <div className="receipt-detail-summary">
        <DetailField label="Дата и время">{new Date(value.createdAt).toLocaleString('ru-RU')}</DetailField>
        <DetailField label="Кассир">{cashier?formatPersonShortName(cashier):'—'}</DetailField>
        <DetailField label="Покупатель">{value.customerName||'Розничный покупатель'}{phone&&<small>{phone}</small>}</DetailField>
        <DetailField label="Статус">{asStatus(value.status)}</DetailField>
      </div>

      <div className="receipt-detail-lines">
        <header><span>Позиция</span><span>Кол-во × цена</span><span>Сумма</span></header>
        {lines.map((line)=><article key={line.key}>
          <div>
            <b>{line.name}</b>
            <small>{(line.discountPercent>0?'Скидка '+line.discountPercent+'%':'Без скидки')+(line.returnedQuantity>0?' · возвращено '+line.returnedQuantity:'')}</small>
          </div>
          <span>{line.quantity} × {formatMoney(line.unitPriceMinor)}</span>
          <strong>{formatMoney(line.lineTotalMinor)}</strong>
        </article>)}
      </div>

      <div className="receipt-detail-bottom">
        <section>
          <h3>Оплата</h3>
          {payments.map((payment,index)=><div key={index}><span>{payment.label}</span><strong>{formatMoney(payment.amountMinor)}</strong></div>)}
        </section>
        <section>
          <div><span>До скидок</span><strong>{formatMoney(gross)}</strong></div>
          {discount>0&&<div><span>Скидки</span><strong>− {formatMoney(discount)}</strong></div>}
          {cached&&cached.returnedMinor>0&&<div><span>Возвращено</span><strong>{formatMoney(cached.returnedMinor)}</strong></div>}
          <div className="receipt-detail-total"><span>Итого</span><strong>{formatMoney(value.totalMinor)}</strong></div>
        </section>
      </div>
  </PosModal>
}

function DetailField({label,children}:{label:string;children:ReactNode}){
  return <div><small>{label}</small><b>{children}</b></div>
}
