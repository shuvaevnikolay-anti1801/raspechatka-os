import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BootState, SaleDetails } from '../shared/contracts'
import type { PrintProvider } from './providers/contracts'
import type { PosDatabase } from './database'
import { CommodityPrintQueue } from './print-jobs'

const folders:string[]=[]
const queues:CommodityPrintQueue[]=[]

afterEach(()=>{
  queues.splice(0).forEach((queue)=>queue.close())
  folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))
})

const sale:SaleDetails={
  id:'sale-1',receiptNumber:'1',totalMinor:10000,returnedMinor:0,paymentMethod:'cash',createdAt:'2026-09-10T10:00:00.000Z',
  status:'completed',lines:[{id:1,productId:'p1',name:'Печать',quantity:1,unitPriceMinor:10000,returnedQuantity:0}],
  payments:[{method:'cash',amountMinor:10000}]
}
const boot:BootState={
  pointId:'point',pointName:'Распечатка',workplaceId:'workplace',workstationName:'Касса 1',cashierName:'Кассир',employees:[{id:'employee-1',name:'Кассир'}],
  online:false,pendingSync:1,source:'demo',shift:null,
  rules:{allowFreePrice:true,allowRemoveCartItem:true,allowDiscounts:true,maxDiscountPercent:50,acceptsCash:true,acceptsCard:false,acceptsQr:false,acceptsRemotePayment:true}
}

const makeQueue=(printer:PrintProvider)=>{
  const folder=mkdtempSync(join(tmpdir(),'raspechatka-print-jobs-'))
  folders.push(folder)
  const database={getSale:(id:string)=>{expect(id).toBe('sale-1');return sale}} as unknown as PosDatabase
  const queue=new CommodityPrintQueue(join(folder,'print.sqlite'),database,printer,()=>boot)
  queues.push(queue)
  return queue
}

describe('CommodityPrintQueue',()=>{
  it('keeps failed print as retryable job without changing the sale',async()=>{
    const printer:PrintProvider={
      healthCheck:async()=>({ready:false,status:'offline',message:'Нет бумаги'}),
      listPrinters:async()=>[],getSelectedPrinter:()=>undefined,setSelectedPrinter:async()=>undefined,
      printCommodityReceipt:async()=>{throw new Error('Нет бумаги')}
    }
    const queue=makeQueue(printer)
    await expect(queue.printSale('sale-1')).rejects.toThrow('Нет бумаги')
    const jobs=queue.listPending()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].saleId).toBe('sale-1')
    expect(jobs[0].state).toBe('error')
    expect(jobs[0].attempts).toBe(1)
  })

  it('retries the same persistent job instead of creating duplicates',async()=>{
    let shouldFail=true
    const printer:PrintProvider={
      healthCheck:async()=>({ready:true,status:'ready',message:'OK'}),
      listPrinters:async()=>[],getSelectedPrinter:()=>undefined,setSelectedPrinter:async()=>undefined,
      printCommodityReceipt:async()=>{
        if(shouldFail)throw new Error('Принтер выключен')
        return {kind:'commodity',status:'printed',message:'Напечатано'}
      }
    }
    const queue=makeQueue(printer)
    await expect(queue.printSale('sale-1')).rejects.toThrow()
    const job=queue.listPending()[0]
    shouldFail=false
    await expect(queue.retry(job.id)).resolves.toMatchObject({status:'printed'})
    expect(queue.listPending()).toHaveLength(0)
    expect(queue.getBySaleId('sale-1')?.attempts).toBe(2)
  })

  it('marks interrupted printing as pending after application restart',async()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-print-restart-'))
    folders.push(folder)
    const database={getSale:()=>sale} as unknown as PosDatabase
    const printer:PrintProvider={
      healthCheck:async()=>({ready:true,status:'ready',message:'OK'}),
      listPrinters:async()=>[],getSelectedPrinter:()=>undefined,setSelectedPrinter:async()=>undefined,
      printCommodityReceipt:async()=>new Promise(()=>undefined)
    }
    const path=join(folder,'print.sqlite')
    const first=new CommodityPrintQueue(path,database,printer,()=>boot)
    const job=first.enqueue('sale-1')
    first.close()
    const second=new CommodityPrintQueue(path,database,printer,()=>boot)
    queues.push(second)
    expect(second.getBySaleId(job.saleId)?.state).toBe('pending')
  })
})
