import { describe, expect, it } from 'vitest'
import { CashierAuthSession } from './cashier-auth'
import { PosDatabase } from './database'

const create=()=>{
  const database=new PosDatabase(':memory:')
  database.replacePointEmployees([{id:'cashier-a',name:'Анна'},{id:'cashier-b',name:'Борис'}])
  return {database,auth:new CashierAuthSession(database)}
}

describe('DEV-163 cashier hand-off auth invariants',()=>{
  it('allows logout only when no work shift is open',()=>{
    const {database,auth}=create()
    try{
      auth.createPin('cashier-a','1357','1357')
      auth.lock()
      const state=auth.logout()
      expect(state.status).toBe('signed_out')
      expect(state.employee).toBeUndefined()
    }finally{
      database.close()
    }
  })

  it('keeps logout and cashier switching blocked while a work shift is open',()=>{
    const {database,auth}=create()
    try{
      auth.createPin('cashier-a','1357','1357')
      database.openShift({id:'shift-a',openedAt:new Date().toISOString(),cashierId:'cashier-a',cashierName:'Анна'})
      auth.lock()
      expect(()=>auth.logout()).toThrow(/Сначала закройте смену/)
      expect(()=>auth.begin('cashier-b')).toThrow(/Анна/)
      expect(auth.state().status).toBe('locked')
      expect(auth.state().employee?.id).toBe('cashier-a')
    }finally{
      database.close()
    }
  })
})
