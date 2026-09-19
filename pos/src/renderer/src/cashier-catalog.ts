import type { Product } from '../../shared/contracts'

export type CatalogTypeFilter='all'|'service'|'product'|'bundle'
export type CatalogCategory={name:string;count:number}

const normalize=(value:string)=>value.trim().toLocaleLowerCase('ru')

export function buildCatalogCategories(products:Product[]):CatalogCategory[]{
  const counts=new Map<string,number>()
  products.forEach((product)=>counts.set(product.category,(counts.get(product.category)??0)+1))
  return [
    {name:'Все',count:products.length},
    ...Array.from(counts,([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name,'ru')),
  ]
}

export function filterCatalogProducts(
  products:Product[],
  filters:{query:string;category:string;type:CatalogTypeFilter},
):Product[]{
  const query=normalize(filters.query)
  return products.filter((product)=>{
    if(filters.category!=='Все'&&product.category!==filters.category)return false
    if(filters.type!=='all'&&product.type!==filters.type)return false
    if(!query)return true
    return normalize([product.name,product.sku,product.barcode??'',product.category].join(' ')).includes(query)
  })
}
