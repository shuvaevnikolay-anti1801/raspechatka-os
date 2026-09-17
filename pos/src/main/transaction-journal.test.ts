import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TransactionJournal } from './transaction-journal'

const folders:string[]=[]
const journals:TransactionJournal[]=[]
const createJournal=()=>{
  const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-journal-'))
  folders.push(folder)
  const journal=new TransactionJournal(join(folder,'journal.sqlite'))
  journals.push(journal)
  return {journal,folder}
}
afterEach(()=>{
  journals.splice(0).forEach((journal)=>journal.close())
  folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))
})

const saleRequest={clientRequestId:'request-1',lines:[{productId:'item',name:'Товар',quantity:1,unitPriceMinor:10000}],payments:[{method:'card' as const,amountMinor:10000}]}

describe('TransactionJournal',()=>{
  it('persists an operation before external side effects',()=>{
    const {journal}=createJournal()
    const operation=journal.create({id:'op-1',clientRequestId:'request-1',kind:'sale',entityId:'sale-1',shiftId:'shift-1',amountMinor:10000,request:saleRequest})
    expect(operation.state).toBe('created')
    expect(journal.listUnresolved()).toHaveLength(1)
  })

  it('preserves ambiguous payment state across process restart',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-restart-'))
    folders.push(folder)
    const path=join(folder,'journal.sqlite')
    const first=new TransactionJournal(path)
    first.create({id:'op-1',clientRequestId:'request-1',kind:'sale',entityId:'sale-1',shiftId:'shift-1',amountMinor:10000,request:saleRequest})
    first.startPaymentAttempt({id:'attempt-1',operationId:'op-1',action:'charge',method:'card',amountMinor:10000})
    first.setState('op-1','payment_unknown','connection lost')
    first.close()

    const second=new TransactionJournal(path)
    journals.push(second)
    const restored=second.get('op-1')
    expect(restored?.state).toBe('payment_unknown')
    expect(restored?.lastError).toBe('connection lost')
    expect(second.getLatestPaymentAttempt('op-1')?.state).toBe('in_progress')
  })

  it('keeps payment and fiscal attempts as separate audit records',()=>{
    const {journal}=createJournal()
    journal.create({id:'op-1',clientRequestId:'request-1',kind:'sale',entityId:'sale-1',shiftId:'shift-1',amountMinor:10000,request:saleRequest})
    journal.startPaymentAttempt({id:'payment-1',operationId:'op-1',action:'charge',method:'card',amountMinor:10000})
    journal.finishPaymentAttempt({id:'payment-1',state:'approved',transactionId:'bank-123'})
    journal.setConfirmedPayments('op-1',[{method:'card',amountMinor:10000,transactionId:'bank-123'}])
    journal.setState('op-1','payment_confirmed')
    journal.startFiscalAttempt({id:'fiscal-1',operationId:'op-1',action:'sale'})
    journal.finishFiscalAttempt({id:'fiscal-1',state:'fiscalized',receiptNumber:'FD-1'})
    journal.setFiscalReceipt('op-1','FD-1')
    journal.setState('op-1','completed')
    expect(journal.listUnresolved()).toHaveLength(0)
    expect(journal.get('op-1')?.fiscalReceiptNumber).toBe('FD-1')
  })
})
