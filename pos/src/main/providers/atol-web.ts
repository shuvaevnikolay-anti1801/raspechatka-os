import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { PaymentPart } from '../../shared/contracts'
import type {
  DeviceHealth, FiscalOperationStatus, FiscalProvider, FiscalRequest, FiscalResult, FiscalReturnRequest, PrintResult
} from './contracts'

export type AtolSettings = {
  enabled:boolean
  baseUrl:string
  taxationType:string
  taxType:string
  operatorName?:string
}

const DEFAULT_SETTINGS:AtolSettings={
  enabled:false,
  baseUrl:'http://127.0.0.1:16732/api/v2',
  taxationType:'patent',
  taxType:'none'
}

export class AtolSettingsStore {
  constructor(private readonly filePath:string){}
  load():AtolSettings{
    if(!existsSync(this.filePath))return {...DEFAULT_SETTINGS}
    try{return {...DEFAULT_SETTINGS,...JSON.parse(readFileSync(this.filePath,'utf-8')) as Partial<AtolSettings>}}
    catch{return {...DEFAULT_SETTINGS}}
  }
  save(value:Partial<AtolSettings>):AtolSettings{
    const current=this.load()
    const next:AtolSettings={...current,...value,baseUrl:(value.baseUrl??current.baseUrl).trim().replace(/\/$/,'')}
    const url=new URL(next.baseUrl)
    if(!['http:','https:'].includes(url.protocol))throw new Error('Адрес ATOL Web Server должен начинаться с http:// или https://')
    writeFileSync(this.filePath,JSON.stringify(next,null,2),'utf-8')
    return next
  }
}

type AtolTaskResult={
  error?:{code?:number;description?:string}|null
  result?:Record<string,unknown>
}

type AtolTaskResponse={results?:AtolTaskResult[]}

export class AtolWebFiscalProvider implements FiscalProvider {
  constructor(private readonly settingsStore:AtolSettingsStore){}

  async healthCheck():Promise<DeviceHealth>{
    const settings=this.settingsStore.load()
    if(!settings.enabled)return {ready:false,status:'not_configured',message:'АТОЛ 1Ф не включён в настройках'}
    try{
      const shift=await this.getShiftStatus()
      return {ready:true,status:'ready',message:shift.message,details:{baseUrl:settings.baseUrl}}
    }catch(error){
      return {ready:false,status:'offline',message:error instanceof Error?error.message:String(error),details:{baseUrl:settings.baseUrl}}
    }
  }

  async getShiftStatus():Promise<{open:boolean;message:string}>{
    const task=await this.execute(randomUUID(),{type:'getShiftStatus'},8000)
    const state=String(((task.result?.shiftStatus as Record<string,unknown>|undefined)?.state)??'unknown')
    if(state==='opened')return {open:true,message:'АТОЛ готов · смена открыта'}
    if(state==='closed')return {open:false,message:'АТОЛ готов · смена закрыта'}
    if(state==='expired')return {open:true,message:'Фискальная смена истекла и требует закрытия'}
    throw new Error(`АТОЛ вернул неизвестное состояние смены: ${state}`)
  }

  async openShift():Promise<void>{
    const settings=this.requireSettings()
    const request:Record<string,unknown>={type:'openShift',electronically:false}
    if(settings.operatorName)request.operator={name:settings.operatorName}
    await this.execute(randomUUID(),request,20000)
  }

  async closeShift():Promise<{message:string;reportNumber?:string}>{
    const settings=this.requireSettings()
    const request:Record<string,unknown>={type:'closeShift',electronically:false}
    if(settings.operatorName)request.operator={name:settings.operatorName}
    const task=await this.execute(randomUUID(),request,30000)
    const result=task.result??{}
    return {message:'Фискальная смена закрыта',reportNumber:this.pickString(result,['fiscalDocumentNumber','documentNumber','shiftNumber'])}
  }

  async fiscalizeSale(request:FiscalRequest):Promise<FiscalResult>{
    const task=await this.execute(request.operationId,this.buildReceipt('sell',request.amountMinor,request.payments,request.lines),45000)
    return this.parseFiscalResult(task,request.operationId)
  }

  async fiscalizeReturn(request:FiscalReturnRequest):Promise<FiscalResult>{
    const task=await this.execute(request.operationId,this.buildReceipt('sellReturn',request.amountMinor,request.payments,request.lines),45000)
    return this.parseFiscalResult(task,request.operationId)
  }

  async getOperationStatus(request:{operationId:string}):Promise<FiscalOperationStatus>{
    const settings=this.requireSettings()
    try{
      const response=await this.fetchJson(`${settings.baseUrl}/requests/${encodeURIComponent(request.operationId)}`,{method:'GET'},5000)
      const task=(response as AtolTaskResponse).results?.[0]
      if(!task)return {status:'unknown',message:'ATOL Web Server ещё не вернул результат операции'}
      if(task.error&&Number(task.error.code??0)!==0)return {status:'not_found',message:task.error.description||'Фискальная операция не выполнена',raw:task}
      const parsed=this.tryParseFiscalResult(task)
      return parsed?{status:'fiscalized',receiptNumber:parsed.receiptNumber,raw:task}:{status:'unknown',message:'ATOL выполнил задачу, но фискальный номер пока не найден в ответе',raw:task}
    }catch(error){
      return {status:'unknown',message:error instanceof Error?error.message:String(error)}
    }
  }

  async reprintReceipt(request:{saleId:string;receiptNumber:string}):Promise<PrintResult>{
    await this.execute(randomUUID(),{type:'printLastReceiptCopy'},20000)
    return {kind:'fiscal-copy',status:'printed',message:`Копия последнего фискального чека отправлена на АТОЛ (${request.receiptNumber})`}
  }

  private buildReceipt(type:'sell'|'sellReturn',amountMinor:number,payments:PaymentPart[],lines:FiscalRequest['lines']):Record<string,unknown>{
    const settings=this.requireSettings()
    const aggregated=new Map<'cash'|'electronically',number>()
    for(const payment of payments){
      const key=payment.method==='cash'?'cash':'electronically'
      aggregated.set(key,(aggregated.get(key)??0)+payment.amountMinor)
    }
    const body:Record<string,unknown>={
      type,
      taxationType:settings.taxationType,
      electronically:false,
      ignoreNonFiscalPrintErrors:false,
      payments:[...aggregated.entries()].map(([paymentType,sum])=>({type:paymentType,sum:sum/100})),
      total:amountMinor/100
    }
    if(lines.length){
      body.items=lines.map((line)=>({
        type:'position',
        name:line.name,
        price:line.unitPriceMinor/100,
        quantity:line.quantity,
        amount:Math.round(line.quantity*line.unitPriceMinor)/100,
        paymentObject:(line as typeof line & {itemType?:string}).itemType==='service'?'service':'commodity',
        paymentMethod:'fullPayment',
        tax:{type:settings.taxType}
      }))
    }
    if(settings.operatorName)body.operator={name:settings.operatorName}
    return body
  }

  private parseFiscalResult(task:AtolTaskResult,operationId:string):FiscalResult{
    if(task.error&&Number(task.error.code??0)!==0)throw new Error(task.error.description||`АТОЛ не выполнил фискальную операцию ${operationId}`)
    const result=this.tryParseFiscalResult(task)
    if(!result)throw new Error('АТОЛ сообщил об окончании операции, но не вернул идентификатор фискального документа')
    return result
  }

  private tryParseFiscalResult(task:AtolTaskResult):FiscalResult|undefined{
    const result=task.result??{}
    const fiscalParams=(result.fiscalParams as Record<string,unknown>|undefined)??{}
    const receiptNumber=this.pickString(fiscalParams,['fiscalDocumentNumber','documentNumber','receiptNumber'])
      ??this.pickString(result,['fiscalDocumentNumber','documentNumber','receiptNumber'])
    if(!receiptNumber)return undefined
    return {
      receiptNumber,
      documentNumber:this.pickString(result,['documentNumber']),
      fiscalDocumentNumber:this.pickString(fiscalParams,['fiscalDocumentNumber']),
      fiscalSign:this.pickString(fiscalParams,['fiscalSign','fiscalSignShort']),
      shiftNumber:this.pickString(fiscalParams,['shiftNumber'])??this.pickString(result,['shiftNumber']),
      raw:task
    }
  }

  private async execute(uuid:string,request:Record<string,unknown>,waitMs:number):Promise<AtolTaskResult>{
    const settings=this.requireSettings()
    await this.fetchJson(`${settings.baseUrl}/requests`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uuid,request:[request]})
    },5000)

    const deadline=Date.now()+waitMs
    while(Date.now()<deadline){
      const response=await this.fetchJson(`${settings.baseUrl}/requests/${encodeURIComponent(uuid)}`,{method:'GET'},5000) as AtolTaskResponse
      const task=response.results?.[0]
      if(task)return task
      await new Promise((resolve)=>setTimeout(resolve,350))
    }
    throw new Error(`АТОЛ не подтвердил завершение операции ${uuid} за ${Math.round(waitMs/1000)} сек.`)
  }

  private requireSettings():AtolSettings{
    const settings=this.settingsStore.load()
    if(!settings.enabled)throw new Error('АТОЛ 1Ф не настроен. Откройте «Оборудование» и включите ККТ.')
    return settings
  }

  private async fetchJson(url:string,init:RequestInit,timeoutMs:number):Promise<unknown>{
    const controller=new AbortController()
    const timer=setTimeout(()=>controller.abort(),timeoutMs)
    try{
      const response=await fetch(url,{...init,signal:controller.signal})
      const text=await response.text()
      if(!response.ok)throw new Error(`ATOL Web Server: HTTP ${response.status}${text?` · ${text.slice(0,250)}`:''}`)
      return text?JSON.parse(text):{}
    }catch(error){
      if(error instanceof Error&&error.name==='AbortError')throw new Error('ATOL Web Server не ответил вовремя')
      throw error
    }finally{clearTimeout(timer)}
  }

  private pickString(source:Record<string,unknown>,keys:string[]):string|undefined{
    for(const key of keys){
      const value=source[key]
      if(value!==undefined&&value!==null&&String(value).trim())return String(value)
    }
    return undefined
  }
}
