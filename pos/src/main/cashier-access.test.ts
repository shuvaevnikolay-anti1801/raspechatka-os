import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PosDatabase } from './database'

const folders:string[]=[]
const databases:PosDatabase[]=[]
const create=()=>{
  const folder=mkdtempSync(join(tmpdir(),'pos-cashier-context-'))
  folders.push(folder)
  const database=new PosDatabase(join(folder,'pos.sqlite'))
  databases.push(database)
  return database
}
afterEach(()=>{
  databases.splice(0).forEach((database)=>database.close())
  folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))
})

describe('cashier operation context',()=>{
  it('keeps the active employee identity on an operation queued from their shift',()=>{
    const database=create()
    database.openShift({id:'shift-a',openedAt:new Date().toISOString(),cashierId:'employee-a',cashierName:'Анна'})

    database.addCashOperation('deposit',10_000,'Размен')

    const event=database.pendingEvents().find((item)=>item.eventType==='cash.deposited')
    expect(event?.payload).toMatchObject({cashierId:'employee-a'})
  })
})
