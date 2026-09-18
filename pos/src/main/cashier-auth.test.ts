import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CashierAuthSession, verifyAdminCode } from './cashier-auth'
import { PosDatabase } from './database'

const folders:string[]=[]
const databases:PosDatabase[]=[]
const create=()=>{const folder=mkdtempSync(join(tmpdir(),'pos-auth-'));folders.push(folder);const database=new PosDatabase(join(folder,'pos.sqlite'));databases.push(database);database.replacePointEmployees([{id:'cashier-a',name:'Анна'},{id:'cashier-b',name:'Борис'}]);return {database,auth:new CashierAuthSession(database)}}
afterEach(()=>{databases.splice(0).forEach((database)=>database.close());folders.splice(0).forEach((folder)=>rmSync(folder,{recursive:true,force:true}))})

describe('local cashier PIN authentication',()=>{
  it('stores only a verifier and supports offline login',()=>{
    const {database,auth}=create()
    expect(auth.begin('cashier-a')).toEqual({requiresPinSetup:true})
    expect(auth.createPin('cashier-a','1357','1357').status).toBe('authenticated')
    expect(JSON.stringify(database.getCashierPin('cashier-a'))).not.toContain('1357')
    auth.logout()
    expect(auth.login('cashier-a','1357').employee?.id).toBe('cashier-a')
    expect(()=>auth.login('cashier-a','9999')).toThrow(/Неверный PIN/)
  })

  it('reserves 0000 for administration and requires it for reset',()=>{
    const {auth}=create()
    expect(verifyAdminCode('0000')).toBe(true)
    expect(()=>auth.createPin('cashier-a','0000','0000')).toThrow(/зарезервирован/)
    expect(()=>auth.resetPin('cashier-a','1111','2468','2468')).toThrow(/администратора/)
    auth.resetPin('cashier-a','0000','2468','2468')
    expect(auth.login('cashier-a','2468').status).toBe('authenticated')
  })

  it('does not restore a session and forces the open-shift cashier',()=>{
    const {database,auth}=create();auth.createPin('cashier-a','1357','1357')
    database.openShift({id:'shift-a',openedAt:new Date().toISOString(),cashierId:'cashier-a',cashierName:'Анна'})
    const restarted=new CashierAuthSession(database)
    expect(restarted.state().status).toBe('signed_out')
    expect(()=>restarted.login('cashier-b','1234')).toThrow(/Анна/)
    expect(restarted.login('cashier-a','1357').employee?.id).toBe('cashier-a')
  })

  it('lets a revoked cashier authenticate only to close an existing shift',()=>{
    const {database,auth}=create();auth.createPin('cashier-a','1357','1357')
    database.openShift({id:'shift-a',openedAt:new Date().toISOString(),cashierId:'cashier-a',cashierName:'Анна'})
    database.replacePointEmployees([{id:'cashier-b',name:'Борис'}])
    const restarted=new CashierAuthSession(database);restarted.login('cashier-a','1357')
    expect(()=>restarted.requireAuthenticated()).toThrow(/отозван/)
    expect(restarted.requireAuthenticated({allowRevokedForClose:true}).id).toBe('cashier-a')
  })
})
