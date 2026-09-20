import { describe, expect, it } from 'vitest'
import type { Product } from '../../shared/contracts'
import { buildCatalogCategories, filterCatalogProducts } from './cashier-catalog'

const products:Product[]=[
  {id:'print',name:'Печать A4',sku:'SVC-1',category:'Печать',type:'service',uom:'лист',priceMinor:2000,barcode:'46001'},
  {id:'paper',name:'Бумага A4',sku:'PRD-1',category:'Товары',type:'product',uom:'пачка',priceMinor:45000},
  {id:'photo',name:'Фото на документы',sku:'SVC-2',category:'Фото',type:'service',uom:'комплект',priceMinor:40000},
]

describe('cashier catalog',()=>{
  it('builds category counters from existing products',()=>{
    expect(buildCatalogCategories(products)).toEqual([
      {name:'Все',count:3},
      {name:'Печать',count:1},
      {name:'Товары',count:1},
      {name:'Фото',count:1},
    ])
  })

  it('combines category, type and text filters',()=>{
    expect(filterCatalogProducts(products,{query:'46001',category:'Все',type:'service'}).map((item)=>item.id)).toEqual(['print'])
    expect(filterCatalogProducts(products,{query:'a4',category:'Товары',type:'product'}).map((item)=>item.id)).toEqual(['paper'])
    expect(filterCatalogProducts(products,{query:'',category:'Фото',type:'product'})).toEqual([])
  })
})
