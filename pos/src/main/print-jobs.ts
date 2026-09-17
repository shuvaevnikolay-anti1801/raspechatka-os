import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { BootState, PrintJobSummary, PrintResult } from '../shared/contracts'
import { PosDatabase } from './database'
import type { PrintProvider } from './providers/contracts'

export class CommodityPrintQueue {
  private readonly db:DatabaseSync
  private retryTimer:NodeJS.Timeout|undefined
  private running=false

  constructor(
    filePath:string,
    private readonly posDatabase:PosDatabase,
    private readonly printProvider:PrintProvider,
    private readonly getBootState:()=>BootState
  ){
    this.db=new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS print_jobs (
        id TEXT PRIMARY KEY,
        sale_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind = 'commodity'),
        state TEXT NOT NULL CHECK(state IN ('pending','printing','printed','error')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        printed_at TEXT,
        UNIQUE(sale_id,kind)
      );
      CREATE INDEX IF NOT EXISTS idx_print_jobs_state_updated
        ON print_jobs(state,updated_at);
    `)
    // Если приложение аварийно завершилось во время печати, попытка считается незавершённой.
    // Бумажный товарный чек не является фискальным документом, поэтому его безопасно повторить.
    this.db.prepare("UPDATE print_jobs SET state='pending',last_error='Печать была прервана перезапуском приложения',updated_at=? WHERE state='printing'")
      .run(new Date().toISOString())
  }

  close():void{
    if(this.retryTimer)clearInterval(this.retryTimer)
    this.db.close()
  }

  enqueue(saleId:string):PrintJobSummary{
    const existing=this.getBySaleId(saleId)
    if(existing)return existing
    const now=new Date().toISOString()
    const id=randomUUID()
    this.db.prepare(`INSERT INTO print_jobs(id,sale_id,kind,state,attempts,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(id,saleId,'commodity','pending',0,now,now)
    return this.get(id)!
  }

  listPending():PrintJobSummary[]{
    return (this.db.prepare(`SELECT id,sale_id saleId,kind,state,attempts,last_error lastError,
      created_at createdAt,updated_at updatedAt,printed_at printedAt
      FROM print_jobs WHERE state IN ('pending','error','printing') ORDER BY created_at`).all() as any[])
      .map((row)=>this.row(row))
  }

  getBySaleId(saleId:string):PrintJobSummary|null{
    const row=this.db.prepare(`SELECT id,sale_id saleId,kind,state,attempts,last_error lastError,
      created_at createdAt,updated_at updatedAt,printed_at printedAt
      FROM print_jobs WHERE sale_id=? AND kind='commodity'`).get(saleId) as any
    return row?this.row(row):null
  }

  async printSale(saleId:string):Promise<PrintResult>{
    const job=this.enqueue(saleId)
    return this.process(job.id)
  }

  async retry(jobId:string):Promise<PrintResult>{
    const job=this.get(jobId)
    if(!job)throw new Error('Задание печати не найдено')
    return this.process(job.id)
  }

  startAutomaticRetry(intervalMs=30000):()=>void{
    if(this.retryTimer)return()=>this.stopAutomaticRetry()
    const tick=()=>{void this.retryPending(3)}
    this.retryTimer=setInterval(tick,intervalMs)
    setTimeout(tick,2500)
    return()=>this.stopAutomaticRetry()
  }

  private stopAutomaticRetry():void{
    if(this.retryTimer){clearInterval(this.retryTimer);this.retryTimer=undefined}
  }

  private async retryPending(limit:number):Promise<void>{
    if(this.running)return
    const health=await this.printProvider.healthCheck().catch(()=>null)
    if(!health?.ready)return
    this.running=true
    try{
      for(const job of this.listPending().filter((item)=>item.state!=='printing').slice(0,limit)){
        try{await this.process(job.id)}catch{/* Ошибка сохранена в самом print job. */}
      }
    }finally{this.running=false}
  }

  private async process(jobId:string):Promise<PrintResult>{
    const job=this.get(jobId)
    if(!job)throw new Error('Задание печати не найдено')
    if(job.state==='printed')return {kind:'commodity',status:'printed',message:'Товарный чек уже был напечатан'}

    const now=new Date().toISOString()
    this.db.prepare("UPDATE print_jobs SET state='printing',attempts=attempts+1,last_error=NULL,updated_at=? WHERE id=?")
      .run(now,jobId)
    try{
      const sale=this.posDatabase.getSale(job.saleId)
      const result=await this.printProvider.printCommodityReceipt(sale,this.getBootState())
      const printedAt=new Date().toISOString()
      this.db.prepare("UPDATE print_jobs SET state='printed',printed_at=?,updated_at=?,last_error=NULL WHERE id=?")
        .run(printedAt,printedAt,jobId)
      return result
    }catch(error){
      const message=error instanceof Error?error.message:String(error)
      this.db.prepare("UPDATE print_jobs SET state='error',last_error=?,updated_at=? WHERE id=?")
        .run(message,new Date().toISOString(),jobId)
      throw new Error(`Товарный чек не напечатан: ${message}`)
    }
  }

  private get(id:string):PrintJobSummary|null{
    const row=this.db.prepare(`SELECT id,sale_id saleId,kind,state,attempts,last_error lastError,
      created_at createdAt,updated_at updatedAt,printed_at printedAt FROM print_jobs WHERE id=?`).get(id) as any
    return row?this.row(row):null
  }

  private row(row:any):PrintJobSummary{
    return {
      id:String(row.id),saleId:String(row.saleId),kind:'commodity',state:row.state,
      attempts:Number(row.attempts||0),lastError:row.lastError||undefined,
      createdAt:String(row.createdAt),updatedAt:String(row.updatedAt),printedAt:row.printedAt||undefined
    }
  }
}
