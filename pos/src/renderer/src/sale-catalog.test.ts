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
  {id:'p-3',category:'Печать',name:'Плакат',sku:'POSTER',barcode:''},
]

describe('sale categories',()=>{
  it('puts Favorites first, keeps real category order, and has no All category',()=>{
    expect(saleCategories(products)).toEqual([FAVORITES_CATEGORY,'Печать','Копии'])
    expect(saleCategories(products)).not.toContain('Все')
  })

  it('renders readable label-only category controls',()=>{
    const source=readFileSync(new URL('./SaleCatalog.tsx',import.meta.url),'utf8')
    const categoriesSource=source.slice(source.indexOf('export function SaleCategories'),source.indexOf('export default function SaleCatalog'))
    expect(categoriesSource).not.toContain('<span')
    expect(categoriesSource).not.toContain('length')
    expect(categoriesSource).not.toMatch(/icon/i)
  })
})

describe('workstation favorites and product cards',()=>{
  it('uses a separate quiet semantic star action that never invokes add',()=>{
    const onAdd=vi.fn()
    const onToggle=vi.fn()
    onToggle('p-1')
    expect(onToggle).toHaveBeenCalledWith('p-1')
    expect(onAdd).not.toHaveBeenCalled()
    const source=readFileSync(new URL('./SaleCatalog.tsx',import.meta.url),'utf8')
    expect(source).toContain('className="product-card-add" onClick={()=>onAdd(product)}')
    expect(source).toContain('icon="star"')
    expect(source).toContain('variant="quiet"')
    expect(source).toContain("onClick={()=>onToggleFavorite(product.id)}")
    expect(source).toContain('aria-pressed={favorite}')
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

  it('searches globally by name across the selected category and Favorites',()=>{
    expect(filterSaleProducts(products,'Печать','  кСеРо  ',['p-1']).map((product)=>product.id)).toEqual(['p-2'])
    expect(filterSaleProducts(products,FAVORITES_CATEGORY,'ПЛАКАТ',['p-1']).map((product)=>product.id)).toEqual(['p-3'])
  })

  it('restores the selected category or Favorites when the query is cleared',()=>{
    expect(filterSaleProducts(products,'Печать','ксеро',['p-1']).map((product)=>product.id)).toEqual(['p-2'])
    expect(filterSaleProducts(products,'Печать','',['p-1']).map((product)=>product.id)).toEqual(['p-1','p-3'])
    expect(filterSaleProducts(products,FAVORITES_CATEGORY,'',['p-1']).map((product)=>product.id)).toEqual(['p-1'])
  })

  it('matches product names only, never SKU or barcode',()=>{
    expect(filterSaleProducts(products,'Копии','photo',[])).toEqual([])
    expect(filterSaleProducts(products,'Копии','200',[])).toEqual([])
    expect(filterSaleProducts(products,'Копии','ФОТО',[]).map((product)=>product.id)).toEqual(['p-1'])
  })

  it('keeps the scanner path separate and F2 focusing the search field',()=>{
    const catalog=readFileSync(new URL('./SaleCatalog.tsx',import.meta.url),'utf8')
    const app=readFileSync(new URL('./AppV2.tsx',import.meta.url),'utf8')
    const hotkeys=readFileSync(new URL('./CashierHotkeys.tsx',import.meta.url),'utf8')
    const css=readFileSync(new URL('./sale-workspace.css',import.meta.url),'utf8')
    expect(catalog).toContain('placeholder="Поиск по наименованию"')
    expect(catalog).not.toContain('<kbd>F2</kbd>')
    expect(css).not.toContain('.search kbd')
    expect(hotkeys).toContain("if(event.key==='F2')")
    expect(hotkeys).toContain("document.querySelector<HTMLInputElement>('.catalog-toolbar .search input')")
    expect(hotkeys).toContain('input?.focus();input?.select()')
    expect(app).toContain('productIds={saleProductIds}')
    expect(app).toContain('const saleProductIds=useMemo(()=>products.map((product)=>product.id),[products])')
    expect(app).toContain('onQueryChange={setQuery} onAdd={add}')
    expect(app).toContain('onSelect={setCategory}')
  })

  it('keeps long names safe and price/stock geometry deterministic',()=>{
    const source=readFileSync(new URL('./SaleCatalog.tsx',import.meta.url),'utf8')
    const css=readFileSync(new URL('./sale-workspace.css',import.meta.url),'utf8')
    expect(source).toContain('className="product-card-name"')
    expect(source).toContain('className="product-card-meta"')
    expect(source).toContain('className="product-card-price"')
    expect(source).toContain("product.stock==null?' empty':''")
    expect(source).toContain('<PosIcon name="inventory"/>')
    expect(source).not.toMatch(/>Остаток\s/)
    expect(css).toContain('-webkit-line-clamp:3')
    expect(css).toContain('overflow-wrap:anywhere')
    expect(css).toContain('grid-template-columns:minmax(0,1fr) 48px')
    expect(css).not.toContain('aspect-ratio')
  })

  it('contains no product image or placeholder-image markup',()=>{
    const source=readFileSync(new URL('./SaleCatalog.tsx',import.meta.url),'utf8')
    expect(source).not.toMatch(/<img|backgroundImage|placeholder-image|product-image/i)
  })
})
