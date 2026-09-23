import { describe, expect, it } from 'vitest'
import { healthFromAtolStatus } from './atol-driver-bridge'

describe('ATOL KKT and FN readiness',()=>{
  const connected={connected:true,serialNumber:'configured',shiftState:'opened',fnPresent:true}
  it('requires positive FN evidence before enabling fiscal work',()=>{
    expect(healthFromAtolStatus({...connected,fnPresent:undefined}).ready).toBe(false)
    expect(healthFromAtolStatus({...connected,fnPresent:false}).ready).toBe(false)
    expect(healthFromAtolStatus(connected).ready).toBe(true)
  })
  it('keeps unsafe hardware and expired shift blocked',()=>{
    for(const state of [
      {...connected,invalidFn:true},
      {...connected,deviceBlocked:true},
      {...connected,shiftState:'expired'},
      {...connected,shiftState:undefined},
      {...connected,shiftState:'unexpected'},
      {...connected,coverOpened:true},
      {...connected,paperPresent:false},
      {...connected,connected:false},
    ])expect(healthFromAtolStatus(state).ready).toBe(false)
  })
})
