import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { PosDatabaseV2 } from './database-v2'

const folders:string[]=[]
const databases:PosDatabaseV2[]=[]

afterEach(()=>{
  databases.splice(0).forEach((database)=>database.close())
  folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))
})

describe('PosDatabaseV2 legacy startup migration',()=>{
  it('opens a database created before normalized_phone existed',()=>{
    const folder=mkdtempSync(join(tmpdir(),'raspechatka-pos-legacy-'))
    folders.push(folder)
    const filePath=join(folder,'test.sqlite')

    const legacy=new DatabaseSync(filePath)
    legacy.exec(`
      CREATE TABLE customers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT,
        discount_percent REAL NOT NULL DEFAULT 0, purchase_count INTEGER NOT NULL DEFAULT 0,
        total_spent_minor INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO customers (id,name,phone,discount_percent)
      VALUES ('legacy-client','Старый клиент','+7 900 123-45-67',5);
    `)
    legacy.close()

    const database=new PosDatabaseV2(filePath)
    databases.push(database)

    expect(database.listCustomers('4567')[0]).toMatchObject({
      id:'legacy-client',
      phone:'+7 900 123-45-67',
      discountPercent:5
    })
  })
})
