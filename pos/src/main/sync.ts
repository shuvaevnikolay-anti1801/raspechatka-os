import type { BootState, ConnectionConfig } from '../shared/contracts'
import { ConnectionStore } from './connection'
import { PosDatabase } from './database'
import { loadBootstrap, pushEvents } from './frappe'

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
      while(database.pendingSyncCount()>0&&guard<100){
        const events=database.pendingEvents(100)
        if(!events.length)break
        const result=await pushEvents(config,events)
        successfulContact=true

        if(result.accepted.length){
          database.markEventsSent(result.accepted)
          acceptedAny=true
        }

        // A partial rejection is a terminal condition for this sync cycle.
        // Accepted IDs are durable and may be read back canonically below, while
        // rejected IDs remain pending for a later cycle instead of hot-looping.
        const acceptedIds=new Set(result.accepted)
        const errors=result.errors.length?result.errors:events
          .filter((event)=>!acceptedIds.has(event.id))
          .map((event)=>({
            id:event.id,
            eventType:event.eventType,
            message:'Сервер не подтвердил событие',
          }))
        if(errors.length){
          outboxError=outboxEventErrorsText(errors)
          break
        }

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
  const flight=runSync(database,connectionStore,cashierId).finally(()=>{
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
