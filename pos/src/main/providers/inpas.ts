import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { InpasSettings, PaymentServiceResult } from '../../shared/contracts'
import type { DeviceHealth, PaymentProvider, PaymentRequest, PaymentResult } from './contracts'

type CommandResult={code:number|null;signal:string|null;stdout:string;stderr:string;timedOut:boolean}
type CommandExecutor=(executable:string,args:string[],options:{cwd:string;timeoutMs:number})=>Promise<CommandResult>

const DEFAULT_SETTINGS:InpasSettings={
  enabled:false,executablePath:'',terminalId:'',currencyCode:'643',timeoutMs:3_600_000,qrMode:'terminal_choice'
}

const decode=(buffer:Buffer)=>new TextDecoder('windows-1251').decode(buffer).replace(/^\uFEFF/,'')

export function parseInpasResult(text:string):Record<string,string>{
  const fields:Record<string,string>={}
  for(const line of text.split(/\r?\n/)){
    const match=line.match(/^\s*\[(\d+)]\s*=\s*['"]?(.*?)['"]?\s*$/)
    if(match)fields[match[1].padStart(2,'0')]=match[2]
  }
  return fields
}

export class InpasSettingsStore{
  constructor(private readonly filePath:string){}
  load():InpasSettings{
    if(!existsSync(this.filePath))return {...DEFAULT_SETTINGS}
    try{return this.normalize({...DEFAULT_SETTINGS,...JSON.parse(readFileSync(this.filePath,'utf-8')) as Partial<InpasSettings>})}
    catch{return {...DEFAULT_SETTINGS}}
  }
  save(value:Partial<InpasSettings>):InpasSettings{
    const next=this.normalize({...this.load(),...value})
    if(next.enabled){
      if(!next.terminalId)throw new Error('Укажите ID терминала INPAS')
      if(!/^\d{3}$/.test(next.currencyCode))throw new Error('Код валюты должен состоять из трёх цифр')
      const executable=this.resolveExecutable(next)
      if(!executable)throw new Error('DC Console.exe не найден. Укажите путь к файлу из установленного DualConnector.')
      next.executablePath=executable
    }
    writeFileSync(this.filePath,JSON.stringify(next,null,2),'utf-8')
    return next
  }
  resolveExecutable(settings=this.load()):string|undefined{
    const configured=settings.executablePath.trim()
    const candidates=[
      configured,
      process.env.RASPECHATKA_INPAS_CONSOLE||'',
      process.env['ProgramFiles(x86)']?join(process.env['ProgramFiles(x86)']!,'INPAS','DualConnector','DC Console.exe'):'',
      process.env['ProgramFiles(x86)']?join(process.env['ProgramFiles(x86)']!,'INPAS','DualConnector','DCConsole.exe'):'',
      process.env.ProgramFiles?join(process.env.ProgramFiles,'INPAS','DualConnector','DC Console.exe'):'',
      process.env.ProgramFiles?join(process.env.ProgramFiles,'INPAS','DualConnector','DCConsole.exe'):''
    ].filter(Boolean).map((item)=>resolve(item))
    return candidates.find((item)=>existsSync(item))
  }
  private normalize(value:InpasSettings):InpasSettings{
    return {
      enabled:Boolean(value.enabled),executablePath:String(value.executablePath||'').trim(),
      terminalId:String(value.terminalId||'').trim(),currencyCode:String(value.currencyCode||'643').trim(),
      timeoutMs:Math.min(Math.max(Number(value.timeoutMs)||3_600_000,30_000),3_600_000),qrMode:'terminal_choice'
    }
  }
}

export class InpasPaymentProvider implements PaymentProvider{
  private running=false
  private healthCache:{at:number;value:DeviceHealth}|undefined
  constructor(
    private readonly settingsStore:InpasSettingsStore,
    private readonly resultDirectory:string,
    private readonly executor:CommandExecutor=executeCommand
  ){mkdirSync(resultDirectory,{recursive:true})}

  settingsChanged():void{this.healthCache=undefined}

  healthCheck():Promise<DeviceHealth>{return this.checkHealth(false)}

  private async checkHealth(force:boolean):Promise<DeviceHealth>{
    const settings=this.settingsStore.load()
    if(!settings.enabled)return {ready:false,status:'not_configured',message:'INPAS / PAX не включён в настройках'}
    if(this.running)return {ready:false,status:'busy',message:'Терминал выполняет операцию'}
    if(!force&&this.healthCache&&Date.now()-this.healthCache.at<30_000)return this.healthCache.value
    const executable=this.settingsStore.resolveExecutable(settings)
    if(!executable)return {ready:false,status:'not_configured',message:'DC Console.exe не найден'}
    if(!settings.terminalId)return {ready:false,status:'not_configured',message:'Не указан ID терминала INPAS'}
    try{
      const result=await this.run('health',`health-${Date.now()}`,10,settings)
      const health:DeviceHealth=result.status==='approved'
        ?{ready:true,status:'ready',message:'INPAS / PAX готов',details:{terminalId:settings.terminalId,executable}}
        :{ready:false,status:'offline',message:result.message||'Терминал не ответил',details:{terminalId:settings.terminalId}}
      this.healthCache={at:Date.now(),value:health}
      return health
    }catch(error){
      const health:DeviceHealth={ready:false,status:'offline',message:error instanceof Error?error.message:String(error)}
      this.healthCache={at:Date.now(),value:health};return health
    }
  }

  charge(request:PaymentRequest):Promise<PaymentResult>{return this.run('charge',request.operationId,request.amountMinor)}
  refund(request:PaymentRequest):Promise<PaymentResult>{return this.run('refund',request.operationId,request.amountMinor)}

  async getOperationStatus(request:PaymentRequest):Promise<PaymentResult>{
    const stored=this.readStoredResult(request.operationId)
    return stored??{status:'unknown',message:'DCConsole не поддерживает безопасный запрос статуса по ID. Проверьте чек терминала и банковский журнал.'}
  }

  async reconcile():Promise<PaymentServiceResult>{
    const operationId=`reconcile-${Date.now()}`
    const result=await this.run('reconcile',operationId,undefined)
    if(result.status!=='approved')throw new Error(result.message||'Сверка итогов INPAS не выполнена')
    return {message:'Сверка итогов INPAS выполнена',receipt:(result.raw as any)?.receipt,raw:result.raw}
  }

  async testConnection():Promise<PaymentServiceResult>{
    const health=await this.checkHealth(true)
    if(!health.ready)throw new Error(health.message)
    return {message:health.message,raw:health.details}
  }

  private async run(kind:'charge'|'refund'|'health'|'reconcile',operationId:string,amountMinor?:number,provided?:InpasSettings):Promise<PaymentResult>{
    if(this.running)throw new Error('Терминал уже выполняет другую операцию')
    const settings=provided??this.settingsStore.load()
    if(!settings.enabled)throw new Error('Эквайринг INPAS выключен в настройках')
    const executable=this.settingsStore.resolveExecutable(settings)
    if(!executable)throw new Error('DC Console.exe не найден')
    if(!settings.terminalId)throw new Error('Не указан ID терминала INPAS')
    const operationCode={charge:'1',refund:'4',health:'26',reconcile:'59'}[kind]
    const args=[`-o${operationCode}`,`-z${settings.terminalId}`]
    if(amountMinor!==undefined)args.push(`-a${amountMinor}`)
    if(kind==='charge'||kind==='refund'||kind==='health')args.push(`-c${settings.currencyCode}`)
    args.push(`-s${settings.timeoutMs}`)
    const cwd=dirname(executable)
    const resultPath=join(cwd,'result.txt')
    const receiptPath=join(cwd,'receipt.txt')
    this.running=true
    try{
      rmSync(resultPath,{force:true});rmSync(receiptPath,{force:true})
      const processResult=await this.executor(executable,args,{cwd,timeoutMs:settings.timeoutMs+5000})
      const fields=existsSync(resultPath)?parseInpasResult(decode(readFileSync(resultPath))):{}
      const receipt=existsSync(receiptPath)?decode(readFileSync(receiptPath)).trim():''
      const raw={kind,exitCode:processResult.code,signal:processResult.signal,fields:this.safeFields(fields),receipt:receipt||undefined,
        stderr:processResult.stderr.trim().slice(0,1000)||undefined}
      let paymentResult:PaymentResult
      if(processResult.timedOut||processResult.signal){
        paymentResult={status:'unknown',message:'Операция INPAS прервана или превысила время ожидания',raw}
      }else if(processResult.code===0){
        paymentResult={status:'approved',transactionId:this.transactionId(operationId,fields,receipt),message:this.resultMessage(fields)||'Операция подтверждена',raw}
      }else{
        paymentResult={status:'declined',message:this.resultMessage(fields)||processResult.stderr.trim()||`INPAS вернул код ${processResult.code}`,raw}
      }
      if(kind==='charge'||kind==='refund')this.storeResult(operationId,paymentResult)
      return paymentResult
    }finally{this.running=false}
  }

  private resultMessage(fields:Record<string,string>):string|undefined{
    return ['64','65','70','01'].map((key)=>fields[key]).find(Boolean)
  }
  private safeFields(fields:Record<string,string>):Record<string,string>{
    const allowed=new Set(['00','01','04','12','13','14','25','26','27','31','59','64','65','70'])
    return Object.fromEntries(Object.entries(fields).filter(([key])=>allowed.has(key)).map(([key,value])=>
      [key,key==='04'?value.replace(/\d(?=\d{4})/g,'*'):value.slice(0,500)]))
  }
  private transactionId(operationId:string,fields:Record<string,string>,receipt:string):string{
    const bankReference=['12','13','14','25'].map((key)=>fields[key]).find(Boolean)
    if(bankReference)return `INPAS-${bankReference}`
    return `INPAS-${createHash('sha256').update(`${operationId}\n${JSON.stringify(this.safeFields(fields))}\n${receipt}`).digest('hex').slice(0,24)}`
  }
  private resultFile(operationId:string):string{return join(this.resultDirectory,`${operationId.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`)}
  private storeResult(operationId:string,result:PaymentResult):void{
    const path=this.resultFile(operationId);const temporary=`${path}.tmp`
    writeFileSync(temporary,JSON.stringify(result),'utf-8');renameSync(temporary,path)
  }
  private readStoredResult(operationId:string):PaymentResult|undefined{
    const path=this.resultFile(operationId)
    if(!existsSync(path))return undefined
    try{return JSON.parse(readFileSync(path,'utf-8')) as PaymentResult}catch{return undefined}
  }
}

function executeCommand(executable:string,args:string[],options:{cwd:string;timeoutMs:number}):Promise<CommandResult>{
  return new Promise((resolvePromise,reject)=>{
    execFile(executable,args,{cwd:options.cwd,windowsHide:true,timeout:options.timeoutMs,encoding:'buffer',maxBuffer:1024*1024},
      (error,stdout,stderr)=>{
        const processError=error as NodeJS.ErrnoException&{code?:string|number;killed?:boolean;signal?:string}
        if(error&&typeof processError.code==='string'&&processError.code!=='ETIMEDOUT')return reject(error)
        resolvePromise({
          code:error?(typeof processError.code==='number'?processError.code:null):0,
          signal:processError?.signal??null,stdout:decode(Buffer.from(stdout||[])),stderr:decode(Buffer.from(stderr||[])),
          timedOut:Boolean(processError?.killed||processError?.code==='ETIMEDOUT')
        })
      })
  })
}
