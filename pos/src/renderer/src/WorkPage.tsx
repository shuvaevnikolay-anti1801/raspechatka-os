import { useState } from 'react'
import type {
  DeliveryNotice, OperationalCatalogItem, Product, StockReceiptRequest, StockWriteOffRequest,
  SupplyRequestInput, UpcomingShift, WorkplaceData, WorkScheduleEntry, WorkScheduleMonth,
} from '../../shared/contracts'
import { formatMoney } from './money'
import { formatPersonShortName } from './person-name'
import { PosButton, PosIconButton } from './ui/PosButton'
import { PosField } from './ui/PosField'
import { PosIcon } from './ui/PosIcon'
import { PosModal } from './ui/PosModal'
import './workplace.css'

export type ReceiveLineDraft={purchaseOrderItemId:string;itemName:string;uom:string;remainingQuantity:number;quantity:number}
export const operationalStockItems=(catalog:OperationalCatalogItem[])=>catalog.filter((item)=>item.trackInventory&&['Product','Variant'].includes(item.itemType))
export const warehouseItemMatches=(item:OperationalCatalogItem,query:string)=>{
  const needle=query.trim().toLocaleLowerCase()
  return !needle||[item.name,item.id,item.itemCode].some((value)=>value.toLocaleLowerCase().includes(needle))
}
export const buildStockReceiptRequest=(purchaseOrderId:string,lines:ReceiveLineDraft[]):StockReceiptRequest=>({
  purchaseOrderId,
  lines:lines
    .filter((line)=>Number.isFinite(line.quantity)&&line.quantity>0&&line.quantity<=line.remainingQuantity)
    .map((line)=>({purchaseOrderItemId:line.purchaseOrderItemId,quantity:line.quantity})),
})

export const shiftDisplayLabel=(shiftCode?:string,shiftName?:string)=>{
  const code=shiftCode?.trim().toUpperCase()
  return code==='U'?'У':code==='V'?'В':shiftCode?.trim()||shiftName||'—'
}

export const scheduleCellPresentation=(entries:Array<Pick<WorkScheduleEntry,'shiftCode'|'shiftName'>>)=>{
  const codes=new Set(entries.map((entry)=>entry.shiftCode?.trim().toUpperCase()).filter(Boolean))
  if(codes.has('U')&&codes.has('V'))return {label:'У/В',className:'schedule-mark schedule-shift-both'}
  const labels=[...new Set(entries.map((entry)=>shiftDisplayLabel(entry.shiftCode,entry.shiftName)))]
  if(codes.size===1&&codes.has('U'))return {label:'У',className:'schedule-mark schedule-shift-morning'}
  if(codes.size===1&&codes.has('V'))return {label:'В',className:'schedule-mark schedule-shift-evening'}
  return {label:labels.join(' · ')||'—',className:entries.length?'schedule-mark schedule-shift-other':''}
}

export const upcomingShiftLabel=(entries:Array<Pick<WorkScheduleEntry,'shiftCode'|'shiftName'>>)=>{
  const codes=new Set(entries.map((entry)=>entry.shiftCode?.trim().toUpperCase()).filter(Boolean))
  if(codes.has('U')&&codes.has('V'))return 'Утро / вечер'
  if(codes.size===1&&codes.has('U'))return 'Утро'
  if(codes.size===1&&codes.has('V'))return 'Вечер'
  const labels=[...new Set(entries.map((entry)=>entry.shiftName).filter(Boolean))]
  return labels.join(' / ')||'Смена'
}

export const groupUpcomingShifts=(entries:UpcomingShift[])=>{
  const grouped=new Map<string,UpcomingShift[]>()
  entries.forEach((entry)=>grouped.set(entry.date,[...(grouped.get(entry.date)||[]),entry]))
  return [...grouped.entries()].map(([date,dayEntries])=>({date,entries:dayEntries}))
}

const monthHeading=(month:string,fallback:string)=>{
  if(!/^\d{4}-\d{2}$/.test(month))return fallback
  return new Date(month+'-01T00:00:00').toLocaleDateString('ru-RU',{month:'long',year:'numeric'})
}

function ScheduleMonthCard({scheduleMonth,fallback}:{scheduleMonth:WorkScheduleMonth;fallback:string}){
  const days=Array.from({length:scheduleMonth.days||0},(_,index)=>index+1)
  const label=monthHeading(scheduleMonth.month,fallback)
  const gridColumns='clamp(176px,15vw,228px) repeat('+days.length+',minmax(clamp(40px,2.45vw,52px),1fr)) minmax(68px,76px)'
  const entriesFor=(employeeId:string,day:number)=>scheduleMonth.entries.filter((entry)=>entry.employeeId===employeeId&&Number(entry.date.slice(-2))===day)

  return <section className="work-card schedule-month">
    <header>
      <div><h3>{label}</h3><p>График точки</p></div>
      <small>Только просмотр</small>
    </header>
    {days.length>0&&scheduleMonth.employees.length
      ?<div className="schedule-grid-scroll">
        <div className="schedule-grid">
          <div className="schedule-grid-row schedule-grid-header" style={{gridTemplateColumns:gridColumns}}>
            <strong>Сотрудник</strong>
            {days.map((day)=>{
              const date=new Date(scheduleMonth.month+'-'+String(day).padStart(2,'0')+'T00:00:00')
              return <span key={day}>{date.toLocaleDateString('ru-RU',{weekday:'short'}).replace('.','')}<b>{day}</b></span>
            })}
            <strong>Часы</strong>
          </div>
          {scheduleMonth.employees.map((employee)=>{
            const entries=days.map((day)=>entriesFor(employee.id,day))
            const hours=entries.flat().reduce((sum,entry)=>sum+entry.plannedHours,0)
            return <div className="schedule-grid-row" key={employee.id} style={{gridTemplateColumns:gridColumns}}>
              <strong title={employee.name}>{formatPersonShortName(employee.name)}</strong>
              {entries.map((dayEntries,dayIndex)=>{
                const presentation=scheduleCellPresentation(dayEntries)
                const title=dayEntries.map((entry)=>entry.shiftName+' · '+entry.startTime.slice(0,5)+'–'+entry.endTime.slice(0,5)).join(' | ')
                return <span key={dayIndex} className={presentation.className} title={dayEntries.length?title:undefined}>{presentation.label}</span>
              })}
              <b>{hours} ч.</b>
            </div>
          })}
        </div>
      </div>
      :<p>На {label} опубликованного графика пока нет.</p>}
  </section>
}

type WorkPageProps={
  products:Product[]
  data:WorkplaceData
  shiftOpen:boolean
  onChanged:()=>Promise<void>
  notify:(text:string)=>void
}

export default function WorkPage({products:_products,data,shiftOpen,onChanged,notify}:WorkPageProps){
  const [tab,setTab]=useState<'schedule'|'stock'|'cleaner'>('schedule')
  const upcomingDays=groupUpcomingShifts(data.myUpcomingShifts)
  const currentScheduleMonth=data.scheduleCurrentMonth||data.scheduleMonth
  const nextScheduleMonth=data.scheduleNextMonth

  return <main className="page">
    <div className="page-heading"><div><h1>Рабочее место</h1></div></div>
    <div className="work-tabs" role="tablist" aria-label="Раздел рабочего места">
      <PosButton role="tab" aria-selected={tab==='schedule'} variant={tab==='schedule'?'primary':'quiet'} size="compact" className={tab==='schedule'?'work-tab active':'work-tab'} onClick={()=>setTab('schedule')}>График работы</PosButton>
      <PosButton role="tab" aria-selected={tab==='stock'} variant={tab==='stock'?'primary':'quiet'} size="compact" className={tab==='stock'?'work-tab active':'work-tab'} onClick={()=>setTab('stock')}>Товары и склад</PosButton>
      <PosButton role="tab" aria-selected={tab==='cleaner'} variant={tab==='cleaner'?'primary':'quiet'} size="compact" className={tab==='cleaner'?'work-tab active':'work-tab'} onClick={()=>setTab('cleaner')}>Уборка{data.cleaner.paymentDueMinor>0&&<b>!</b>}</PosButton>
    </div>

    {tab==='schedule'&&<div className="work-schedule">
      <section className="work-card schedule-upcoming">
        <h3>Мои ближайшие 5 смен</h3>
        {upcomingDays.length
          ?upcomingDays.map(({date,entries})=>{
            const presentation=scheduleCellPresentation(entries)
            const value=new Date(date+'T00:00:00')
            return <article className="upcoming-shift" key={date}>
              <time dateTime={date}>
                <span>{value.toLocaleDateString('ru-RU',{weekday:'long'})}</span>
                <b>{value.toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}</b>
              </time>
              <span className={presentation.className}>{upcomingShiftLabel(entries)}</span>
            </article>
          })
          :<p>Ближайших опубликованных смен пока нет.</p>}
      </section>
      <ScheduleMonthCard scheduleMonth={currentScheduleMonth} fallback="Текущий месяц"/>
      <ScheduleMonthCard scheduleMonth={nextScheduleMonth} fallback="Следующий месяц"/>
    </div>}

    {tab==='stock'&&<WarehouseWorkspace data={data} onChanged={onChanged} notify={notify}/>}

    {tab==='cleaner'&&<div className="work-grid">
      <section className="work-card hero-card">
        <small>УБОРОК ДО ВЫПЛАТЫ</small>
        <h2>{Math.min(data.cleaner.visitsSincePayment,4)} из 4</h2>
        <p>Каждое посещение отмечается один раз.</p>
        <PosButton variant="primary" size="touch" onClick={async()=>{
          try{
            const r=await window.raspechatkaPos.recordCleanerVisit()
            await onChanged()
            notify(r.paymentDueMinor?'Четыре уборки отмечены — можно выплатить 2 000 ₽':'Посещение уборщицы отмечено')
          }catch(e){notify(String(e))}
        }}>Отметить сегодняшнюю уборку</PosButton>
        {data.cleaner.paymentDueMinor>0&&<PosButton className="pay-cleaner" variant="secondary" size="touch" disabled={!shiftOpen} onClick={async()=>{
          try{
            await window.raspechatkaPos.payCleaner(data.cleaner.paymentDueMinor)
            await onChanged()
            notify('Выплата уборщице проведена как изъятие из кассы')
          }catch(e){notify(e instanceof Error?e.message:String(e))}
        }}>Выплатить {formatMoney(data.cleaner.paymentDueMinor)} из кассы</PosButton>}
      </section>
      <section className="work-card">
        <h3>Последние посещения</h3>
        {data.cleaner.recentVisits.length
          ?data.cleaner.recentVisits.map((x)=><article key={x.id}><div><b>{new Date(x.visitDate+'T00:00:00').toLocaleDateString('ru-RU')}</b><small>{x.recordedBy}</small></div><span>{x.paid?'Оплачено':'Ожидает'}</span></article>)
          :<p>Посещений пока нет</p>}
      </section>
    </div>}
  </main>
}

export function WarehouseWorkspace({data,onChanged,notify}:{data:WorkplaceData;onChanged:()=>Promise<void>;notify:(text:string)=>void}){
  const [writeOff,setWriteOff]=useState(false)
  const [need,setNeed]=useState(false)
  const [receiveOrder,setReceiveOrder]=useState<DeliveryNotice|null>(null)
  const [stockQuery,setStockQuery]=useState('')
  const catalog=data.operationalCatalog||[]
  const stockProducts=operationalStockItems(catalog)
  const stockRows=stockProducts.filter((item)=>warehouseItemMatches(item,stockQuery))

  return <div className="warehouse-workspace">
    <div className="warehouse-actions" data-workplace-block="actions">
      <PosButton variant="danger" size="touch" className="warehouse-action warehouse-action-writeoff" onClick={()=>setWriteOff(true)}>Списать брак</PosButton>
      <PosButton variant="primary" size="touch" className="warehouse-action warehouse-action-need" onClick={()=>setNeed(true)}>Заказать</PosButton>
    </div>

    <section className="work-card delivery-list warehouse-deliveries" data-workplace-block="deliveries">
      <header><h2>Поставки</h2><small>Открытые заказы текущей точки</small></header>
      <div className="delivery-list-scroll">
        {data.deliveries.length
          ?data.deliveries.map((order)=><DeliveryCard key={order.id} order={order} onReceive={()=>setReceiveOrder(order)}/>)
          :<WorkEmpty title="Поставок нет" text="Открытые заказы появятся здесь из OS."/>}
      </div>
    </section>

    <section className="work-card stock-list warehouse-stock" data-workplace-block="stock">
      <PosField label="Поиск" className="warehouse-search">
        <input value={stockQuery} onChange={(e)=>setStockQuery(e.target.value)} placeholder="Название товара"/>
      </PosField>
      <div className="stock-table-scroll">
        <header><span>Товар</span><span>Остаток</span><span>Где лежит</span></header>
        {stockRows.length
          ?stockRows.map((item)=><div key={item.id}>
            <div><b title={item.name}>{item.name}</b></div>
            <strong className={(item.stock??0)<=0?'low':''}>{item.stock??'—'} {item.uom}</strong>
            <span>{item.storageAddress||'Адрес ещё не указан'}</span>
          </div>)
          :<p>Складские позиции не найдены.</p>}
      </div>
    </section>

    {writeOff&&<WriteOffModal products={stockProducts} onClose={()=>setWriteOff(false)} onComplete={async(request)=>{
      try{
        await window.raspechatkaPos.reportStockWriteOff(request)
        setWriteOff(false)
        await onChanged()
        notify('Списание поставлено в очередь и уйдёт в OS при синхронизации')
      }catch(e){notify(e instanceof Error?e.message:String(e))}
    }}/>}

    {need&&<SupplyRequestModal products={catalog} onClose={()=>setNeed(false)} onComplete={async(request)=>{
      try{
        await window.raspechatkaPos.createSupplyRequest(request)
        setNeed(false)
        await onChanged()
        notify('Заказ для точки сохранён на кассе и будет передан в OS при синхронизации')
      }catch(e){notify(e instanceof Error?e.message:String(e))}
    }}/>}

    {receiveOrder&&<ReceiveModal order={receiveOrder} onClose={()=>setReceiveOrder(null)} onComplete={async(request)=>{
      try{
        await window.raspechatkaPos.createStockReceipt(request)
        setReceiveOrder(null)
        await onChanged()
        notify('Приёмка сохранена на кассе и будет передана в OS при синхронизации')
      }catch(e){notify(e instanceof Error?e.message:String(e))}
    }}/>}
  </div>
}

function WorkEmpty({title,text}:{title:string;text:string}){
  return <div className="page-empty warehouse-empty"><PosIcon name="inventory"/><b>{title}</b><span>{text}</span></div>
}

function DeliveryCard({order,onReceive}:{order:DeliveryNotice;onReceive:()=>void}){
  const remaining=order.items.filter((item)=>item.remainingQuantity>0)
  const notes=[order.comment,order.receivingNote,order.details].filter((value,index,all)=>value&&all.indexOf(value)===index)
  const deliveryMeta=[
    order.deliveryCompany&&'Перевозчик: '+order.deliveryCompany,
    order.deliveryCode&&'Код доставки: '+order.deliveryCode,
  ].filter(Boolean) as string[]

  return <article className="delivery-card">
    <header className="delivery-heading">
      <div>
        <small>ПОСТАВЩИК</small>
        <strong title={order.supplier}>{order.supplier}</strong>
      </div>
      <div className="delivery-status">
        <span>{order.expectedDate?new Date(order.expectedDate+'T00:00:00').toLocaleDateString('ru-RU'):'Дата не назначена'}</span>
        <b>{order.status}</b>
      </div>
    </header>
    {deliveryMeta.length>0&&<div className="delivery-meta">{deliveryMeta.map((value)=><span key={value}>{value}</span>)}</div>}
    {notes.map((note)=><p className="delivery-note" key={note}>{note}</p>)}
    <div className="delivery-lines">
      <strong>Осталось принять: {remaining.length} поз.</strong>
      {remaining.map((item)=><div key={item.purchaseOrderItemId}>
        <span><b title={item.itemName}>{item.itemName}</b></span>
        <b>{item.remainingQuantity} {item.uom}</b>
      </div>)}
    </div>
    {remaining.length>0&&<PosButton variant="primary" size="touch" className="delivery-receive" onClick={onReceive}>Создать приёмку</PosButton>}
  </article>
}

export function WriteOffModal({products,onClose,onComplete}:{products:OperationalCatalogItem[];onClose:()=>void;onComplete:(request:StockWriteOffRequest)=>Promise<void>}){
  const [productId,setProductId]=useState('')
  const [productQuery,setProductQuery]=useState('')
  const [quantity,setQuantity]=useState('1')
  const [reason,setReason]=useState<StockWriteOffRequest['reason']>('Брак')
  const [comment,setComment]=useState('')
  const productOptions=products.filter((item)=>warehouseItemMatches(item,productQuery)).slice(0,8)
  const selectProduct=(item:OperationalCatalogItem)=>{setProductId(item.id);setProductQuery(item.name)}

  return <PosModal
    open
    title="Списать товар"
    onClose={onClose}
    layout="form"
    className="warehouse-modal warehouse-writeoff-modal"
    footer={<>
      <PosButton variant="secondary" onClick={onClose}>Отмена</PosButton>
      <PosButton variant="danger" size="touch" className="warehouse-confirm" disabled={!productId||Number(quantity)<=0||!comment.trim()} onClick={()=>onComplete({productId,quantity:Number(quantity),reason,comment:comment.trim()})}>Подтвердить списание</PosButton>
    </>}
  >
    <p className="warehouse-modal-intro">Списание изменит фактический остаток товара.</p>
    <div className="warehouse-warning" role="note">Проверьте товар, количество и причину перед подтверждением.</div>
    <div className="warehouse-form">
      <div className="warehouse-field-wide warehouse-product-picker">
        <PosField label="Товар" helper={productId?'Товар выбран':'Выберите товар из списка'}>
          <input
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={productOptions.length>0}
            value={productQuery}
            onChange={(e)=>{setProductQuery(e.target.value);setProductId('')}}
            placeholder="Начните вводить название товара"
          />
        </PosField>
        {productOptions.length>0&&<div className="warehouse-product-options" role="listbox" aria-label="Товары">
          {productOptions.map((item)=><PosButton
            key={item.id}
            variant="quiet"
            size="control"
            className="warehouse-product-option"
            role="option"
            aria-selected={item.id===productId}
            onClick={()=>selectProduct(item)}
          ><span>{item.name}</span><small>Остаток {item.stock??0} {item.uom}</small></PosButton>)}
        </div>}
      </div>
      <PosField label="Количество">
        <input type="number" min="0.001" step="0.001" value={quantity} onChange={(e)=>setQuantity(e.target.value)}/>
      </PosField>
      <PosField label="Причина">
        <select value={reason} onChange={(e)=>setReason(e.target.value as StockWriteOffRequest['reason'])}>
          <option>Брак</option><option>Внутренние нужды</option><option>Обучение</option>
        </select>
      </PosField>
      <PosField label="Комментарий" helper="обязательно" size="textarea" className="warehouse-field-wide">
        <textarea required value={comment} onChange={(e)=>setComment(e.target.value)} placeholder="Что произошло — коротко"/>
      </PosField>
    </div>
  </PosModal>
}

export function SupplyRequestModal({products,onClose,onComplete}:{products:OperationalCatalogItem[];onClose:()=>void;onComplete:(request:SupplyRequestInput)=>Promise<void>}){
  const [productId,setProductId]=useState('')
  const [itemName,setItemName]=useState('')
  const [comment,setComment]=useState('')
  const select=(id:string)=>{setProductId(id);setItemName(products.find((x)=>x.id===id)?.name||'')}

  return <PosModal
    open
    title="Заказать"
    onClose={onClose}
    layout="form"
    className="warehouse-modal warehouse-supply-modal"
    footer={<>
      <PosButton variant="secondary" onClick={onClose}>Отмена</PosButton>
      <PosButton variant="primary" size="touch" className="warehouse-confirm" disabled={!itemName.trim()||!comment.trim()} onClick={()=>onComplete({productId:productId||undefined,itemName:itemName.trim(),comment:comment.trim()})}>Заказать</PosButton>
    </>}
  >
    <p className="warehouse-modal-intro">Укажите, что требуется заказать для точки.</p>
    <div className="warehouse-form">
      <PosField label="Позиция из каталога" className="warehouse-field-wide">
        <select value={productId} onChange={(e)=>select(e.target.value)}>
          <option value="">Другая позиция</option>
          {products.map((x)=><option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </PosField>
      <PosField label="Наименование или описание" className="warehouse-field-wide">
        <input value={itemName} onChange={(e)=>{setItemName(e.target.value);setProductId('')}} placeholder="Например: бумага А4"/>
      </PosField>
      <PosField label="Комментарий" helper="обязательно" size="textarea" className="warehouse-field-wide">
        <textarea required value={comment} onChange={(e)=>setComment(e.target.value)} placeholder="Срочность или уточнение"/>
      </PosField>
    </div>
  </PosModal>
}

export function ReceiveModal({order,onClose,onComplete}:{order:DeliveryNotice;onClose:()=>void;onComplete:(request:StockReceiptRequest)=>Promise<void>}){
  const [lines,setLines]=useState<ReceiveLineDraft[]>(()=>order.items.filter((item)=>item.remainingQuantity>0).map((item)=>({
    purchaseOrderItemId:item.purchaseOrderItemId,
    itemName:item.itemName,
    uom:item.uom,
    remainingQuantity:item.remainingQuantity,
    quantity:item.remainingQuantity,
  })))
  const update=(id:string,quantity:number)=>setLines((current)=>current.map((line)=>line.purchaseOrderItemId===id?{...line,quantity}:line))
  const invalid=lines.some((line)=>!Number.isFinite(line.quantity)||line.quantity<0||line.quantity>line.remainingQuantity)
  const request=buildStockReceiptRequest(order.id,lines)

  return <PosModal
    open
    title={'Заказ № '+order.id}
    onClose={onClose}
    layout="matrix"
    className="warehouse-modal warehouse-receive-modal"
    footer={<>
      <PosButton variant="secondary" onClick={onClose}>Отмена</PosButton>
      <PosButton variant="primary" size="touch" className="warehouse-confirm" disabled={invalid||request.lines.length===0} onClick={()=>onComplete(request)}>Подтвердить приёмку</PosButton>
    </>}
  >
    <div className="receive-context">
      <div>
        <strong title={order.supplier}>{order.supplier}</strong>
        <span>{order.expectedDate?<>Ожидаемая дата: <b>{new Date(order.expectedDate+'T00:00:00').toLocaleDateString('ru-RU')}</b></>:'Дата поставки не назначена'}</span>
      </div>
      <b>{order.status}</b>
    </div>
    <div className="receive-lines">
      {lines.length
        ?lines.map((line)=><div className="receive-line" key={line.purchaseOrderItemId}>
          <div className="receive-item">
            <b title={line.itemName}>{line.itemName}</b>
            <small>Осталось по заказу: {line.remainingQuantity} {line.uom}</small>
          </div>
          <PosField label={'Количество, '+line.uom} className="receive-quantity">
            <input type="number" min="0" max={line.remainingQuantity} step="0.001" value={line.quantity} onChange={(e)=>update(line.purchaseOrderItemId,Number(e.target.value))}/>
          </PosField>
          <PosIconButton icon="trash" label={'Убрать '+line.itemName} variant="danger" className="receive-remove" onClick={()=>setLines((current)=>current.filter((x)=>x.purchaseOrderItemId!==line.purchaseOrderItemId))}/>
        </div>)
        :<p>Нет строк для приёмки.</p>}
    </div>
    {invalid&&<div className="error-note warehouse-error" role="alert">Количество не может превышать остаток по заказу.</div>}
  </PosModal>
}
