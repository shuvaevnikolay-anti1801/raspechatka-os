import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SALE_LAYOUT,
  SALE_LAYOUT_LIMITS,
  SALE_PREFERENCES_KEY,
  clampSaleLayout,
  parseSalePreferences,
} from './sale-preferences'

describe('sale workstation preferences',()=>{
  it('falls back safely for corrupted or unsupported preferences',()=>{
    expect(parseSalePreferences('{broken',1200)).toEqual({
      version:1,
      layout:clampSaleLayout(DEFAULT_SALE_LAYOUT,1200),
      favoriteProductIds:[],
    })
    expect(parseSalePreferences(JSON.stringify({version:2,layout:{categoriesRatio:.9,receiptRatio:.9}}),1200).layout)
      .toEqual(clampSaleLayout(DEFAULT_SALE_LAYOUT,1200))
  })

  it('clamps restored ratios and retains the flexible catalog minimum',()=>{
    const width=1200
    const layout=clampSaleLayout({categoriesRatio:.9,receiptRatio:.9},width)
    const usable=width-SALE_LAYOUT_LIMITS.splitterWidth*2
    expect(layout.categoriesRatio).toBeLessThanOrEqual(SALE_LAYOUT_LIMITS.categoriesMaxRatio)
    expect(layout.receiptRatio).toBeLessThanOrEqual(SALE_LAYOUT_LIMITS.receiptMaxRatio)
    expect((1-layout.categoriesRatio-layout.receiptRatio)*usable).toBeGreaterThanOrEqual(SALE_LAYOUT_LIMITS.catalogMin-0.001)
  })

  it('preserves valid favorite IDs while parsing layout preferences',()=>{
    const parsed=parseSalePreferences(JSON.stringify({
      version:1,
      layout:{categoriesRatio:.18,receiptRatio:.36},
      favoriteProductIds:['product-1','product-2','product-1',42],
    }),1280)
    expect(parsed.favoriteProductIds).toEqual(['product-1','product-2'])
  })

  it('uses one profile key with no cashier identity',()=>{
    expect(SALE_PREFERENCES_KEY).toBe('raspechatka.pos.sale-preferences.v1')
    expect(SALE_PREFERENCES_KEY.toLowerCase()).not.toContain('cashier')
  })
})

describe('sale workspace shell',()=>{
  it('renders exactly two pointer splitters',()=>{
    const source=readFileSync(new URL('./SaleWorkspace.tsx',import.meta.url),'utf8')
    expect(source.match(/data-testid="sale-splitter"/g)).toHaveLength(2)
    expect(source.match(/onPointerDown=/g)).toHaveLength(2)
    expect(source.match(/onPointerMove=/g)).toHaveLength(2)
  })
})
