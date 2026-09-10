import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InpasPaymentProvider, InpasSettingsStore, parseInpasResult } from './inpas'

describe('InpasPaymentProvider',()=>{
  let directory:string
  let executable:string
  let settings:InpasSettingsStore
  const calls:Array<{args:string[];cwd:string}>=[]

  beforeEach(()=>{
    directory=mkdtempSync(join(tmpdir(),'raspechatka-inpas-'))
    executable=join(directory,'DC Console.exe')
    writeFileSync(executable,'test')
    settings=new InpasSettingsStore(join(directory,'settings.json'))
    settings.save({enabled:true,executablePath:executable,terminalId:'40000037',currencyCode:'643',timeoutMs:60000,qrMode:'terminal_choice'})
    calls.length=0
  })
  afterEach(()=>rmSync(directory,{recursive:true,force:true}))

  it('parses numbered fields from a DCConsole result',()=>{
    expect(parseInpasResult("[00] = '1'\r\n[27] = '40000037'\r\n[64] = 'ОДОБРЕНО'"))
      .toEqual({'00':'1','27':'40000037','64':'ОДОБРЕНО'})
  })

  it('runs a sale without a shell and stores the approved result for crash recovery',async()=>{
    const provider=new InpasPaymentProvider(settings,join(directory,'results'),async(_file,args,options)=>{
      calls.push({args,cwd:options.cwd})
      writeFileSync(join(options.cwd,'result.txt'),"[12] = 'RRN-123'\r\n[27] = '40000037'\r\n[64] = 'ОДОБРЕНО'",'latin1')
      writeFileSync(join(options.cwd,'receipt.txt'),'APPROVED','latin1')
      return {code:0,signal:null,stdout:'',stderr:'',timedOut:false}
    })
    const result=await provider.charge({operationId:'attempt-1',saleId:'sale-1',amountMinor:12345,method:'card'})
    expect(calls[0].args).toEqual(['-o1','-z40000037','-a12345','-c643','-s60000'])
    expect(result.status).toBe('approved')
    expect(result.transactionId).toBe('INPAS-RRN-123')
    expect(await provider.getOperationStatus({operationId:'attempt-1',saleId:'sale-1',amountMinor:12345,method:'card'}))
      .toMatchObject({status:'approved',transactionId:'INPAS-RRN-123'})
    expect(JSON.parse(readFileSync(join(directory,'results','attempt-1.json'),'utf-8')).status).toBe('approved')
  })

  it('uses operation 4 for a refund and treats a normal non-zero exit as a decline',async()=>{
    const provider=new InpasPaymentProvider(settings,join(directory,'results'),async(_file,args)=>{
      calls.push({args,cwd:directory})
      writeFileSync(join(directory,'result.txt'),"[64] = 'ОТКАЗ'",'latin1')
      return {code:7,signal:null,stdout:'',stderr:'',timedOut:false}
    })
    const result=await provider.refund({operationId:'refund-1',saleId:'return-1',amountMinor:500,method:'card'})
    expect(calls[0].args[0]).toBe('-o4')
    expect(result.status).toBe('declined')
  })

  it('keeps an interrupted operation unknown',async()=>{
    const provider=new InpasPaymentProvider(settings,join(directory,'results'),async()=>
      ({code:null,signal:'SIGTERM',stdout:'',stderr:'',timedOut:true}))
    const result=await provider.charge({operationId:'timeout-1',saleId:'sale-1',amountMinor:100,method:'qr'})
    expect(result.status).toBe('unknown')
    expect((await provider.getOperationStatus({operationId:'timeout-1',saleId:'sale-1',amountMinor:100,method:'qr'})).status).toBe('unknown')
  })

  it('runs health check and reconciliation with documented operation codes',async()=>{
    const provider=new InpasPaymentProvider(settings,join(directory,'results'),async(_file,args,options)=>{
      calls.push({args,cwd:options.cwd});writeFileSync(join(options.cwd,'result.txt'),"[64] = 'OK'",'latin1')
      return {code:0,signal:null,stdout:'',stderr:'',timedOut:false}
    })
    expect((await provider.healthCheck()).ready).toBe(true)
    await provider.reconcile()
    expect(calls.map((call)=>call.args[0])).toEqual(['-o26','-o59'])
  })
})
