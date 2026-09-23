import { describe, expect, it, vi } from 'vitest'
import type { BootState, HardwareStatus } from '../shared/contracts'
import { collectDeviceStatuses } from './health'

const ready:HardwareStatus={ready:true,status:'ready',message:'готов'}
const down:HardwareStatus={ready:false,status:'offline',message:'нет связи'}
const boot=(online:boolean):BootState=>({
  online,pendingSync:2,lastSyncAt:'2026-09-23T10:00:00.000Z',
  rules:{
    allowFreePrice:false,allowRemoveCartItem:true,allowDiscounts:true,maxDiscountPercent:10,
    acceptsCash:true,acceptsCard:true,acceptsQr:true,acceptsRemotePayment:true,
  },
} as BootState)
const channels=(online=true,payment:HardwareStatus=ready,fiscal:HardwareStatus=ready,ofd?:HardwareStatus)=>({
  boot:boot(online),connectionConfigured:true,localOpen:true,
  fiscal:{
    healthCheck:vi.fn(async()=>fiscal),
    getShiftStatus:vi.fn(async()=>({open:true,state:'opened' as const,message:'смена открыта'})),
    ofdDeliveryHealth:vi.fn(async()=>ofd??{
      ready:false,status:'unknown' as const,message:'Нет данных Driver об ОФД',
    }),
  },
  payment:{healthCheck:vi.fn(async()=>payment)},
  printer:{healthCheck:vi.fn(async()=>ready)},
})

describe('independent device health',()=>{
  it('keeps local KKT, FN, terminal and printer ready when the OS is offline',async()=>{
    const source=channels(false)
    const status=await collectDeviceStatuses(source)
    expect(status.os.ready).toBe(false)
    expect(status.fiscal.ready).toBe(true)
    expect(status.payment.ready).toBe(true)
    expect(status.printer.ready).toBe(true)
    expect(status.ofd.status).toBe('unknown')
    expect(status.paymentMethods).toEqual({
      cash:true,card:true,qr:true,remote_payment:false,
    })
  })

  it('disables only terminal methods for an acquiring outage',async()=>{
    const status=await collectDeviceStatuses(channels(true,down))
    expect(status.paymentMethods).toEqual({
      cash:true,card:false,qr:false,remote_payment:true,
    })
    expect(status.fiscal.ready).toBe(true)
  })

  it('does not turn OFD delivery failure into a fiscal readiness failure',async()=>{
    const status=await collectDeviceStatuses(channels(true,ready,ready,{
      ready:false,status:'offline',message:'Задержка ОФД',
    }))
    expect(status.ofd.ready).toBe(false)
    expect(status.fiscal.ready).toBe(true)
    expect(status.paymentMethods.cash).toBe(true)
  })

  it('keeps unsafe FN or KKT as a fiscal blocker independent of payment channels',async()=>{
    const status=await collectDeviceStatuses(channels(true,ready,{
      ready:false,status:'error',message:'ФН заблокирован',
    }))
    expect(status.fiscal.ready).toBe(false)
    expect(status.payment.ready).toBe(true)
    expect(status.shift.ready).toBe(true)
  })

  it('does not infer OFD state from OS and isolates provider failures',async()=>{
    const source=channels(false)
    source.fiscal.ofdDeliveryHealth.mockRejectedValueOnce(new Error('driver code 1'))
    source.payment.healthCheck.mockRejectedValueOnce(new Error('terminal code 2'))
    const status=await collectDeviceStatuses(source)
    expect(status.ofd.status).toBe('unknown')
    expect(status.payment.status).toBe('unknown')
    expect(status.fiscal.ready).toBe(true)
    expect(status.printer.ready).toBe(true)
  })

  it('keeps remote payment independent of PAX and respects point and connection configuration',async()=>{
    const terminalDown=channels(true,down)
    expect((await collectDeviceStatuses(terminalDown)).remotePayment.ready).toBe(true)
    terminalDown.boot.rules.acceptsRemotePayment=false
    expect((await collectDeviceStatuses(terminalDown)).remotePayment.status).toBe('not_configured')
    expect((await collectDeviceStatuses(terminalDown)).paymentMethods.remote_payment).toBe(false)
    terminalDown.boot.rules.acceptsRemotePayment=true
    terminalDown.connectionConfigured=false
    expect((await collectDeviceStatuses(terminalDown)).paymentMethods.remote_payment).toBe(false)
  })

  it('keeps printer and payment rules separate from fiscal and OFD states',async()=>{
    const source=channels(false,down,ready,down)
    source.boot.rules.acceptsCash=false
    source.boot.rules.acceptsQr=false
    source.printer.healthCheck.mockResolvedValueOnce(down)
    const status=await collectDeviceStatuses(source)
    expect(status.printer.ready).toBe(false)
    expect(status.fiscal.ready).toBe(true)
    expect(status.ofd.status).toBe('offline')
    expect(status.paymentMethods).toEqual({cash:false,card:false,qr:false,remote_payment:false})
  })

  it('reports OFD not available for providers without a trustworthy Driver channel',async()=>{
    const source=channels(true)
    const fiscal={healthCheck:source.fiscal.healthCheck,getShiftStatus:source.fiscal.getShiftStatus}
    const status=await collectDeviceStatuses({...source,fiscal})
    expect(status.ofd.status).toBe('not_available')
  })
})
