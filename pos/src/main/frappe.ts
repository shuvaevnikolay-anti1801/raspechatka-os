import type { BootState, ConnectionConfig, Customer, OutboxEvent, PointEmployee, Product, WorkplaceData } from '../shared/contracts'

type BootstrapResponse = {
  point: { id:string; name:string }
  workplace: { id:string; name:string }
  employee?: PointEmployee|null
  employees: PointEmployee[]
  rules: BootState['rules']
  products: Product[]
  customers: Customer[]
  workplaceData: WorkplaceData
}

type FrappeResponse<T>={message?:T;exception?:string;exc_type?:string;_server_messages?:string}

function checkedServerUrl(value:string):URL {
  const url=new URL(value)
  if(!['http:','https:'].includes(url.protocol)) throw new Error('Адрес OS должен начинаться с http:// или https://')
  return url
}

function errorFrom(payload:FrappeResponse<unknown>,status:number):Error{
  let text=payload.exception||''
  if(payload._server_messages){
    try{
      const messages=JSON.parse(payload._server_messages) as string[]
      const decoded=messages.map((item)=>{try{return JSON.parse(item).message as string}catch{return item}}).filter(Boolean)
      if(decoded.length)text=decoded.join(' · ')
    }catch{}
  }
  return new Error(text||`OS ответила с кодом ${status}`)
}

async function post<T>(config:ConnectionConfig,method:string,body:Record<string,unknown>,timeoutMs:number):Promise<T>{
  const url=checkedServerUrl(config.serverUrl)
  url.pathname=`/api/method/${method}`
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs)
  try{
    const response=await fetch(url,{
      method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},
      body:JSON.stringify(body),signal:controller.signal
    })
    const payload=await response.json() as FrappeResponse<T>
    if(!response.ok||payload.message===undefined)throw errorFrom(payload,response.status)
    return payload.message
  }catch(error){
    if(error instanceof DOMException&&error.name==='AbortError')throw new Error('Распечатка OS не ответила вовремя')
    throw error
  }finally{clearTimeout(timer)}
}

export async function pushEvents(config:ConnectionConfig,events:OutboxEvent[]):Promise<string[]> {
  if(!events.length)return []
  const result=await post<{accepted:string[]}>(config,'raspechatka.api.pos_device.push_events',{
    device_id:config.deviceId,token:config.token,cashier_id:config.cashierId||null,
    events,app_version:'0.1.1'
  },20000)
  return result.accepted||[]
}

export async function loadBootstrap(config:ConnectionConfig):Promise<BootstrapResponse> {
  return post<BootstrapResponse>(config,'raspechatka.api.pos_device.get_bootstrap',{
    device_id:config.deviceId,token:config.token,cashier_id:config.cashierId||null
  },15000)
}
