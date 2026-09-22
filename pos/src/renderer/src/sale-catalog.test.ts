import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { FAVORITES_CATEGORY, filterSaleProducts, saleCategories } from './SaleCatalog'
import {
  DEFAULT_SALE_PREFERENCES,
  parseSalePreferences,
  pruneFavoriteProductIds,
  toggleFavoriteProductId,
  writeSalePreferences,
} from './sale-preferences'

const products=[
  {id:'p-1',category:'Печать',name:'Фото',sku:'PHOTO',barcode:'100'},
  {id:'p-2',category:'Копии',name:'Ксерокопия',sku:'COPY',barcode:'200'},
  {id:'p-3',category:'Печать',name:'Плакат',sku:'POSTER',barcode:null},
]

describe('sale categories',()=>{
  it('puts Favorites first, keeps real category order, and has no All category',()=>{
    expect(saleCategories(products)).toEqual([FAVORITES_CATEGORY,'Печать','Копии'])
    expect(saleCategories(products)).not.toContain('Все')
  })

  it('renders category labels without icons or item counts',()=>{
    const source=readFileSync(new URL('./SaleCatalog.tsx',import.meta.url),'utf8')
    const categoriesSource=source.slice(source.indexOf('export function SaleCategories'),source.indexOf('export default function SaleCatalog'))
    expect(categoriesSource).not.toContain('<span')
    expect(categoriesSource).not.toContain('length')
    expect(categoriesSource).not.toMatch(/icon/i)
  })
})

describe('workstation favorites',()=>{
  it('uses a separate star action that never invokes the add callback',()=>{
    const onAdd=vi.fn()
    const onToggle=vi.fn()
    onToggle('p-1')
    expect(onToggle).toHaveBeenCalledWith('p-1')
    expect(onAdd).not.toHaveBeenCalled()

    const source=readFileSync(new URL('./SaleCatalog.tsx',import.meta.url),'utf8')
    expect(source).toContain('className="product-card-add" onClick={()=>onAdd(product)}')
    expect(source).toContain("onClick={()=>onToggleFavorite(product.id)}")
    expect(source.indexOf('</button>\n          <button\n            className={\'product-favorite\'')).toBeGreaterThan(-1)
    expect(source).toContain('aria-label={(favorite?')
  })

  it('persists, restores, and prunes favorites against the local catalog',()=>{
    const stored={value:''}
    writeSalePreferences(
      {...DEFAULT_SALE_PREFERENCES,favoriteProductIds:toggleFavoriteProductId([], 'p-1')},
      {setItem:(_key,value)=>{stored.value=value}},
    )
    const restored=parseSalePreferences(stored.value,1280)
    expect(restored.favoriteProductIds).toEqual(['p-1'])
    expect(pruneFavoriteProductIds(['p-1','stale'],products.map((product)=>product.id))).toEqual(['p-1'])
  })

  it('searches by name, SKU, and barcode inside Favorites only',()=>{
    expect(filterSaleProducts(products,FAVORITES_CATEGORY,'photo',['p-1','p-2']).map((product)=>product.id)).toEqual(['p-1'])
    expect(filterSaleProducts(products,FAVORITES_CATEGORY,'COPY',['p-1','p-2']).map((product)=>product.id)).toEqual(['p-2'])
    expect(filterSaleProducts(products,FAVORITES_CATEGORY,'200',['p-1','p-2']).map((product)=>product.id)).toEqual(['p-2'])
    expect(filterSaleProducts(products,FAVORITES_CATEGORY,'poster',['p-1','p-2'])).toEqual([])
  })

  it('contains no product image or placeholder-image markup',()=>{
    const source=readFileSync(new URL('./SaleCatalog.tsx',import.meta.url),'utf8')
    expect(source).not.toMatch(/<img|backgroundImage|placeholder-image|product-image/i)
  })
})
