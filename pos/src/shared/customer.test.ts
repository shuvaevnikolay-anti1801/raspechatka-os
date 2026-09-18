import { describe, expect, it, vi } from 'vitest'
import { resolveCurrentCustomer } from './customer'

describe('customer snapshot reconciliation',()=>{
  it('uses the current discount when a held or open receipt is restored',async()=>{
    const saved={id:'client-1',name:'Иван',phone:'+79991234821',discountPercent:5}
    const current={...saved,discountPercent:3}
    await expect(resolveCurrentCustomer(saved,vi.fn().mockResolvedValue(current))).resolves.toEqual(current)
  })

  it('removes a customer that disappeared from the active club directory',async()=>{
    const saved={id:'client-1',name:'Иван',phone:'+79991234821',discountPercent:5}
    await expect(resolveCurrentCustomer(saved,vi.fn().mockResolvedValue(null))).resolves.toBeNull()
  })
})
