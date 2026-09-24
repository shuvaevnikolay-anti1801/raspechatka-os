import type { BootState, ConnectionConfig, OutboxEvent, OutboxQueueItem, SyncRetryResult } from '../shared/contracts'
import { ConnectionStore } from './connection'
import { PosDatabase } from './database'
import { loadBootstrap, pushEvents } from './frappe'
import { canCancelSyncQueueEvent, canRetrySyncQueueEvent } from './sync-queue-policy'

const LEGACY_POINT_TIMEZONE = 'Europe/Moscow'
const LEGACY_CLEANING = { payoutAmountMinor: 200000, everyNVisits: 4 }

export function normalizeCleaningConfig(value?:Partial<BootState['cleaning']>):BootState['cleaning']{
  const amount=value?.payoutAmountMinor
  const visits=value?.everyNVisits
  return {
    payoutAmountMinor:typeof amount==='number'&&Number.isSafeInteger(amount)&&amount>0?amount:LEGACY_CLEANING.payoutAmountMinor,
    everyNVisits:typeof visits==='number'&&Number.isSafeInteger(visits)&&visits>=1?visits:LEGACY_CLEANING.everyNVisits,
  }
}

export function buildBootState(database:PosDatabase):BootState{
  const cached=database.getState('bootstrap')
  const remote=cached?JSON.parse(cached) as Partial<BootState>:{}
  if(!database.getState('point_employees_initialized')&&remote.source==='frappe'){
    database.replacePointEmployees(remote.employees||[])
    database.setState('point_employees_initialized','1')
  }
  const employees=database.listPointEmployees()
  const upsellRules=remote.upsellRules??[]
  const upsellCursors=Object.fromEntries(upsellRules.map((rule)=>[rule.triggerItem,database.getUpsellCursor(rule.triggerItem)]))
  return {
    pointId:remote.pointId??'demo-point',pointName:remote.pointName??'Тестовая точка',
    pointTimezone:remote.pointTimezone??LEGACY_POINT_TIMEZONE,
    cleaning:normalizeCleaningConfig(remote.cleaning),
    workplaceId:remote.workplaceId??'demo-workplace',workstationName:remote.workstationName??'Касса 1',
    cashierId:undefined,cashierName:'Выберите сотрудника',employees,
    accessRevoked:false,
    online:Boolean(remote.online),pendingSync:database.pendingSyncCount(),
    masterDataError:database.getState('master_data_error')||undefined,
    documentQueueError:database.getState('outbox_error')||undefined,
    documentQueueSynced:database.pendingSyncCount()===0&&!database.getState('outbox_error'),
    lastSyncAt:remote.lastSyncAt,source:remote.source??'demo',
    shift:database.currentShift(),rules:remote.rules??{
      allowFreePrice:true,allowRemoveCartItem:true,allowDiscounts:true,maxDiscountPercent:100,
      acceptsCash:true,acceptsCard:true,acceptsQr:false,acceptsRemotePayment:true
    },
    upsellRules,upsellCursors
  }
}

async function applyBootstrap(
  database:PosDatabase,
  config:ConnectionConfig,
  cashierId?:string
):Promise<void>{
  const remote=await loadBootstrap(config,cashierId)
  database.replaceProducts(remote.products)
  database.replaceCustomers(remote.customers)
  database.replacePointEmployees(remote.employees||[])
  database.setState('point_employees_initialized','1')
  database.replaceReceiptMirror(remote.point.id,remote.receiptMirror||[],remote.retentionDays||60)
  database.replaceServerOrders(remote.point.id,remote.workplaceData.orders||[],remote.retentionDays||60)
  database.setWorkplaceData(remote.workplaceData)
  const pointTimezone=remote.point.timezone||LEGACY_POINT_TIMEZONE
  const cleaning=normalizeCleaningConfig(remote.point.cleaning)
  database.setState('bootstrap',JSON.stringify({
    pointId:remote.point.id,pointName:remote.point.name,pointTimezone,cleaning,workplaceId:remote.workplace.id,
    workstationName:remote.workplace.name,employees:remote.employees||[],online:true,lastSyncAt:buildBootState(database).lastSyncAt,
    source:'frappe',rules:{...remote.rules,acceptsRemotePayment:true},
    upsellRules:remote.upsellRules||[]
  }))
}

function syncErrorText(bootstrapError:string,outboxError:string):string{
  return [
    bootstrapError&&`Справочники: ${bootstrapError}`,
    outboxError&&`Очередь документов: ${outboxError}`
  ].filter(Boolean).join(' · ')
}

function outboxEventErrorsText(errors:Array<{id:string;eventType:string;message:string}>):string{
  return errors.map((error)=>{
    const eventType=error.eventType||'unknown'
    const eventId=error.id||'без id'
    const message=error.message||'Событие отклонено сервером'
    return `${eventType} (${eventId}): ${message}`
  }).join(' · ')
}

function finishContact(database:PosDatabase,successfulContact:boolean):BootState{
  const current=buildBootState(database)
  const lastSyncAt=successfulContact?new Date().toISOString():current.lastSyncAt
  database.setState('bootstrap',JSON.stringify({...current,online:successfulContact,lastSyncAt}))
  return buildBootState(database)
}

const configurationFlights=new WeakMap<PosDatabase,Promise<BootState>>()

async function runConfigurationSync(
  database:PosDatabase,
  connectionStore:ConnectionStore,
  cashierId?:string
):Promise<BootState>{
  const config=connectionStore.load()
  if(!config)throw new Error('Сначала подключите кассу к Распечатка OS по Device ID и Token')

  try{
    await applyBootstrap(database,config,cashierId)
    database.setState('master_data_error','')
    const outboxError=database.getState('outbox_error')||''
    database.setState('sync_error',syncErrorText('',outboxError))
    return finishContact(database,true)
  }catch(error){
    const bootstrapError=error instanceof Error?error.message:String(error)
    database.setState('master_data_error',bootstrapError)
    const outboxError=database.getState('outbox_error')||''
    database.setState('sync_error',syncErrorText(bootstrapError,outboxError))
    finishContact(database,false)
    throw error
  }
}

export function performConfigurationSync(
  database:PosDatabase,
  connectionStore:ConnectionStore,
  cashierId?:string
):Promise<BootState>{
  const active=configurationFlights.get(database)
  if(active)return active
  const flight=runConfigurationSync(database,connectionStore,cashierId).finally(()=>{
    if(configurationFlights.get(database)===flight)configurationFlights.delete(database)
  })
  configurationFlights.set(database,flight)
  return flight
}

const syncFlights=new WeakMap<PosDatabase,Promise<BootState>>()
const outboxLocks=new WeakMap<PosDatabase,Promise<unknown>>()

export function withOutboxLock<T>(database:PosDatabase,action:()=>Promise<T>):Promise<T>{
  const previous=outboxLocks.get(database)
  const current=previous?previous.catch(()=>undefined).then(action):action()
  outboxLocks.set(database,current)
  void current.finally(()=>{if(outboxLocks.get(database)===current)outboxLocks.delete(database)}).catch(()=>undefined)
  return current
}

async function sendOutboxBatch(database:PosDatabase,config:ConnectionConfig,events:OutboxEvent[],manual=false){
  const ids=events.map((event)=>event.id)
  database.recordEventsAttempted(ids,new Date().toISOString(),manual)
  let result
  try{result=await pushEvents(config,events)}
  catch(error){
    database.recordEventFailure(ids,'temporary','transport')
    throw error
  }
  const sent=new Set(ids)
  const accepted=[...new Set(result.accepted)].filter((id)=>sent.has(id))
  if(accepted.length)database.markEventsSent(accepted)
  const acceptedIds=new Set(accepted)
  const errors=result.errors.filter((error)=>sent.has(error.id)&&!acceptedIds.has(error.id))
  const failedIds=new Set<string>()
  for(const error of errors){
    if(failedIds.has(error.id))continue
    failedIds.add(error.id)
    const kind=/^(?:Неподдерживаемый тип события|Unsupported event(?: type)?|ValidationError:|Invalid event:)/i.test(error.message)
      ?'problem':'temporary'
    database.recordEventFailure([error.id],kind,kind==='problem'
      &&/^(?:Неподдерживаемый тип события|Unsupported event)/i.test(error.message)?'unsupported':'validation')
  }
  const unconfirmed=ids.filter((id)=>!acceptedIds.has(id)&&!failedIds.has(id))
  database.recordEventFailure(unconfirmed,'temporary','unconfirmed')
  const errorText=errors.length||unconfirmed.length?outboxEventErrorsText(errors.length?errors:unconfirmed.map((id)=>({
    id,eventType:events.find((event)=>event.id===id)?.eventType||'unknown',
    message:'Сервер не подтвердил событие',
  }))):''
  return {accepted,errorText}
}

export function retrySingleSyncEvent(database:PosDatabase,connectionStore:ConnectionStore,id:string,blocked:()=>boolean=()=>false):Promise<SyncRetryResult>{
  return withOutboxLock(database,async()=>{
    const event=database.getQueueEvent(id)
    if(!event||!canRetrySyncQueueEvent(event,blocked()))throw new Error('Повтор этого события сейчас недоступен')
    const config=connectionStore.load()
    if(!config)throw new Error('Подключение к OS не настроено')
    let message='Документ отправлен'
    try{
      const result=await sendOutboxBatch(database,config,[{
        id:event.id,eventType:event.eventType,payload:event.payload,createdAt:event.createdAt,
      }],true)
      if(!result.accepted.includes(id))message='Сервер не подтвердил документ. Проверьте состояние в очереди'
      database.setState('outbox_error',result.errorText)
    }catch{
      message='Связь с OS недоступна. Документ остаётся в очереди'
      database.setState('outbox_error',message)
    }
    database.setState('sync_error',syncErrorText(database.getState('master_data_error')||'',database.getState('outbox_error')||''))
    return {message,event:database.getQueueEvent(id) as OutboxQueueItem}
  })
}

export function discardSingleSyncEvent(
  database:PosDatabase,id:string,blocked:()=>boolean,
  audit:(event:OutboxQueueItem)=>void,
):Promise<OutboxQueueItem>{
  return withOutboxLock(database,async()=>{
    const event=database.getQueueEvent(id)
    if(!event||!canCancelSyncQueueEvent(event,blocked()))
      throw new Error('Документ уже отправлен либо его нельзя исключить из очереди')
    if(!database.discardQueueEvent(id))throw new Error('Состояние документа изменилось. Обновите очередь')
    audit(event)
    return database.getQueueEvent(id) as OutboxQueueItem
  })
}

async function runSync(database:PosDatabase,connectionStore:ConnectionStore,cashierId?:string):Promise<BootState>{
  const config=connectionStore.load()
  if(!config)throw new Error('Сначала подключите кассу к Распечатка OS по Device ID и Token')

  let bootstrapError=''
  let outboxError=''
  let successfulContact=false
  let acceptedAny=false

  // Справочники и очередь бизнес-документов синхронизируются независимо.
  // Ошибка каталога/клиентов не должна блокировать уже созданные документы.
  try{
    await applyBootstrap(database,config,cashierId)
    database.setState('master_data_error','')
    successfulContact=true
  }catch(error){
    bootstrapError=error instanceof Error?error.message:String(error)
    database.setState('master_data_error',bootstrapError)
  }

  if(database.getState('outbox_paused')==='1'){
    database.setState('outbox_error','')
  }else{
    try{
      let guard=0
      while(guard<100){
        const events=database.pendingEvents(100)
        if(!events.length)break
        const result=await sendOutboxBatch(database,config,events)
        successfulContact=true
        if(result.accepted.length)acceptedAny=true
        if(result.errorText)outboxError=result.errorText
        guard++
      }
      database.setState('outbox_error',outboxError)
    }catch(error){
      outboxError=error instanceof Error?error.message:String(error)
      database.setState('outbox_error',outboxError)
    }
  }

  // Read-after-write: once the server accepted queued documents, reload canonical
  // orders/master data in the same cycle. Accepted events stay marked sent even
  // if this read fails; replaying an already accepted external event would be wrong.
  if(acceptedAny){
    try{
      await applyBootstrap(database,config,cashierId)
      bootstrapError=''
      database.setState('master_data_error','')
      successfulContact=true
    }catch(error){
      bootstrapError=error instanceof Error?error.message:String(error)
      database.setState('master_data_error',bootstrapError)
    }
  }

  const syncError=syncErrorText(bootstrapError,outboxError)
  database.setState('sync_error',syncError)

  const result=finishContact(database,successfulContact)
  if(!successfulContact){
    throw new Error(syncError||'Не удалось связаться с Распечатка OS')
  }
  return result
}

export function performSync(database:PosDatabase,connectionStore:ConnectionStore,cashierId?:string):Promise<BootState>{
  const active=syncFlights.get(database)
  if(active)return active
  const flight=withOutboxLock(database,()=>runSync(database,connectionStore,cashierId)).finally(()=>{
    if(syncFlights.get(database)===flight)syncFlights.delete(database)
  })
  syncFlights.set(database,flight)
  return flight
}

export function startAutomaticSync(database:PosDatabase,connectionStore:ConnectionStore,cashierId:()=>string|undefined=()=>undefined):()=>void{
  let stopped=false
  let timer:NodeJS.Timeout|undefined
  let delayMs=5000
  const run=async()=>{
    if(stopped)return
    if(!connectionStore.load()){
      timer=setTimeout(run,30000)
      return
    }
    try{
      const activeCashierId=cashierId()
      if(activeCashierId)await performSync(database,connectionStore,activeCashierId)
      else await performConfigurationSync(database,connectionStore)
      delayMs=15000
    }catch{
      delayMs=Math.min(Math.max(delayMs*2,15000),120000)
    }
    timer=setTimeout(run,delayMs)
  }
  timer=setTimeout(run,1500)
  return ()=>{stopped=true;if(timer)clearTimeout(timer)}
}
