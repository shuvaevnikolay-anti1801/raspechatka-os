import type { BootState } from '../shared/contracts'
import { ConnectionStore } from './connection'
import { PosDatabase } from './database'
import { loadBootstrap, pushEvents } from './frappe'

export function buildBootState(database:PosDatabase):BootState{
  const cached=database.getState('bootstrap')
  const remote=cached?JSON.parse(cached) as Partial<BootState>:{}
  return {
    pointId:remote.pointId??'demo-point',pointName:remote.pointName??'Тестовая точка',
    workplaceId:remote.workplaceId??'demo-workplace',workstationName:remote.workstationName??'Касса 1',
    cashierName:remote.cashierName??'Администратор',online:Boolean(remote.online),
    pendingSync:database.pendingSyncCount(),lastSyncAt:remote.lastSyncAt,source:remote.source??'demo',
    shift:database.currentShift(),rules:remote.rules??{
      allowFreePrice:true,allowRemoveCartItem:true,allowDiscounts:true,maxDiscountPercent:100,
      acceptsCash:true,acceptsCard:true,acceptsQr:false,acceptsRemotePayment:true
    }
  }
}

export async function performSync(database:PosDatabase,connectionStore:ConnectionStore):Promise<BootState>{
  const config=connectionStore.load()
  if(!config)throw new Error('Сначала заполните подключение к Распечатка OS')
  try{
    let guard=0
    while(database.pendingSyncCount()>0&&guard<100){
      const events=database.pendingEvents(100)
      if(!events.length)break
      const accepted=await pushEvents(config,events)
      if(!accepted.length)break
      database.markEventsSent(accepted)
      guard++
    }
    const remote=await loadBootstrap(config)
    database.replaceProducts(remote.products)
    database.replaceCustomers(remote.customers)
    database.setWorkplaceData(remote.workplaceData)
    const lastSyncAt=new Date().toISOString()
    database.setState('bootstrap',JSON.stringify({
      pointId:remote.point.id,pointName:remote.point.name,workplaceId:remote.workplace.id,
      workstationName:remote.workplace.name,cashierName:remote.employee.name,online:true,
      lastSyncAt,source:'frappe',rules:{...remote.rules,acceptsRemotePayment:true}
    }))
    database.setState('sync_error','')
    return buildBootState(database)
  }catch(error){
    const message=error instanceof Error?error.message:String(error)
    database.setState('sync_error',message)
    database.setState('bootstrap',JSON.stringify({...buildBootState(database),online:false}))
    throw error
  }
}

export function startAutomaticSync(database:PosDatabase,connectionStore:ConnectionStore):()=>void{
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
      await performSync(database,connectionStore)
      delayMs=15000
    }catch{
      delayMs=Math.min(Math.max(delayMs*2,15000),120000)
    }
    timer=setTimeout(run,delayMs)
  }
  timer=setTimeout(run,1500)
  return ()=>{stopped=true;if(timer)clearTimeout(timer)}
}
