import { describe, expect, it } from 'vitest'
import { formatMoney } from './money'

describe('formatMoney',()=>{
  it('omits zero kopecks for whole rubles',()=>{
    expect(formatMoney(125000)).toContain('1 250')
    expect(formatMoney(125000)).not.toContain(',00')
  })
  it('preserves non-zero kopecks',()=>{
    expect(formatMoney(125050)).toContain('1 250,50')
  })
  it('formats zero and negative values',()=>{
    expect(formatMoney(0)).toContain('0')
    expect(formatMoney(-125000)).toContain('-1 250')
  })
})
