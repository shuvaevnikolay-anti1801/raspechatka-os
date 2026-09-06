import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PosDatabase } from './database'

const folders:string[]=[]
afterEach(()=>{folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))})

describe('PosDatabase',()=>{
  it('creates the local catalog and holds a receipt',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-'))
    folders.push(folder)
    const database=new PosDatabase(join(folder,'test.sqlite'))
    expect(database.listProducts().length).toBeGreaterThan(0)
    const held=database.holdReceipt({label:'Тест',lines:[],discountPercent:0})
    expect(database.listHeldReceipts()[0].id).toBe(held.id)
    database.deleteHeldReceipt(held.id)
    expect(database.listHeldReceipts()).toHaveLength(0)
  })
})
