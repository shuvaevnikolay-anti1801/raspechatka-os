import type { BootState } from '../shared/contracts'
import { ConnectionStore } from './connection'
import { PosDatabase } from './database'
import { loadBootstrap, pushEvents } from './frappe'

const LEGACY_POINT_TIMEZONE = 'Europe/Moscow'

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
    workplaceId:remote.workplaceId??'demo-workplace',workstationName:remote.workstationName??'Касса 1',
    cashierId:undefined,cashierName:'Выберите сотрудника',employees,
    accessRevoked:false,
    online:Boolean(remote.online),pendingSync:database.pendingSyncCount(),lastSyncAt:remote.lastSyncAt,source:remote.source??'demo',
    shift:database.currentShift(),rules:remote.rules??{
      allowFreePrice:true,allowRemoveCartItem:true,allowDiscounts:true,maxDiscountPercent:100,
      acceptsCash:true,acceptsCard:true,acceptsQr:false,acceptsRemotePayment:true
    },
    upsellRules,upsellCursors
  }
}

const syncFlights=new WeakMap<PosDatabase,Promise<BootState>>()

async function runSync(database:PosDatabase,connectionStore:ConnectionStore,cashierId?:string):Promise<BootState>{
  const config=connectionStore.load()
  if(!config)throw new Error('Сначала подключите кассу к Распечатка OS по Device ID и Token')

  let bootstrapError=''
  let outboxError=''
  let successfulContact=false

  const applyBootstrap=async()=>{
    const remote=await loadBootstrap(config,cashierId)
    database.replaceProducts(remote.products)
    database.replaceCustomers(remote.customers)
    database.replacePointEmployees(remote.employees||[])
    database.setState('point_employees_initialized','1')
    database.replaceReceiptMirror(remote.point.id,remote.receiptMirror||[],remote.retentionDays||60)
    database.replaceServerOrders(remote.point.id,remote.workplaceData.orders||[],remote.retentionDays||60)
    database.setWorkplaceData(remote.workplaceData)
    const pointTimezone=remote.point.timezone||LEGACY_POINT_TIMEZONE
    database.setState('bootstrap',JSON.stringify({
      pointId:remote.point.id,pointName:remote.point.name,pointTimezone,workplaceId:remote.workplace.id,
      workstationName:remote.workplace.name,employees:remote.employees||[],online:true,lastSyncAt:buildBootState(database).lastSyncAt,
      source:'frappe',rules:{...remote.rules,acceptsRemotePayment:true},
      upsellRules:remote.upsellRules||[]
    }))
    successfulContact=true
  }

  // Справочники и очередь денежных документов синхронизируются независимо.
  // Ошибка каталога/клиентов не должна блокировать уже созданные чеки и смены.
  try{
    await applyBootstrap()
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
        const accepted=await pushEvents(config,events)
        successfulContact=true
        if(!accepted.length)break
        database.markEventsSent(accepted)
        guard++
      }
      database.setState('outbox_error','')
    }catch(error){
      outboxError=error instanceof Error?error.message:String(error)
      database.setState('outbox_error',outboxError)
    }
  }

  const errors=[bootstrapError&&`Справочники: ${bootstrapError}`,outboxError&&`Очередь документов: ${outboxError}`].filter(Boolean)
  const syncError=errors.join(' · ')
  database.setState('sync_error',syncError)

  const current=buildBootState(database)
  const lastSyncAt=successfulContact?new Date().toISOString():current.lastSyncAt
  database.setState('bootstrap',JSON.stringify({...current,online:successfulContact,lastSyncAt}))

  if(!successfulContact){
    throw new Error(syncError||'Не удалось связаться с Распечатка OS')
  }
  return buildBootState(database)
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
      await performSync(database,connectionStore,cashierId())
      delayMs=15000
    }catch{
      delayMs=Math.min(Math.max(delayMs*2,15000),120000)
    }
    timer=setTimeout(run,delayMs)
  }
  timer=setTimeout(run,1500)
  return ()=>{stopped=true;if(timer)clearTimeout(timer)}
}
