import type { Product } from '../../shared/contracts'
import { formatMoney } from './money'

export const FAVORITES_CATEGORY='Избранное'

type SearchableProduct=Pick<Product,'id'|'category'|'name'|'sku'|'barcode'>

export const saleCategories=(products:ReadonlyArray<Pick<Product,'category'>>)=>
  [FAVORITES_CATEGORY,...new Set(products.map((product)=>product.category).filter((name)=>name&&name!==FAVORITES_CATEGORY))]

export const filterSaleProducts=<T extends SearchableProduct>(
  products:readonly T[],
  category:string,
  query:string,
  favoriteProductIds:readonly string[],
):T[]=>{
  const favoriteIds=new Set(favoriteProductIds)
  const text=query.trim().toLocaleLowerCase('ru')
  return products.filter((product)=>{
    const inCategory=category===FAVORITES_CATEGORY
      ? favoriteIds.has(product.id)
      : product.category===category
    const matchesSearch=!text||(product.name+' '+product.sku+' '+(product.barcode||'')).toLocaleLowerCase('ru').includes(text)
    return inCategory&&matchesSearch
  })
}

export function SaleCategories({
  products,selected,onSelect,
}:{
  products:readonly Product[]
  selected:string
  onSelect:(category:string)=>void
}){
  return <aside className="categories">
    <strong>Категории</strong>
    {saleCategories(products).map((name)=><button key={name} className={selected===name?'active':''} onClick={()=>onSelect(name)}>{name}</button>)}
  </aside>
}

export default function SaleCatalog({
  products,query,category,favoriteProductIds,onQueryChange,onAdd,onToggleFavorite,
}:{
  products:readonly Product[]
  query:string
  category:string
  favoriteProductIds:readonly string[]
  onQueryChange:(query:string)=>void
  onAdd:(product:Product)=>void
  onToggleFavorite:(productId:string)=>void
}){
  const visible=filterSaleProducts(products,category,query,favoriteProductIds)
  const favoriteIds=new Set(favoriteProductIds)
  return <section className="catalog">
    <div className="catalog-toolbar"><label className="search"><span>⌕</span><input autoFocus value={query} onChange={(event)=>onQueryChange(event.target.value)} placeholder="Товар, услуга, артикул или штрихкод"/><kbd>F2</kbd></label></div>
    {!visible.length&&category===FAVORITES_CATEGORY
      ? <div className="favorites-empty"><span aria-hidden="true">★</span><strong>В избранном пока пусто</strong><p>Нажмите ★ на карточке товара, чтобы он появился здесь.</p></div>
      : <div className="product-grid">{visible.map((product)=>{
        const favorite=favoriteIds.has(product.id)
        return <article className="product-card pos-v2-product sale-product-tile" key={product.id}>
          <button className="product-card-add" onClick={()=>onAdd(product)}>
            <strong>{product.name}</strong>
            <footer><b>{formatMoney(product.priceMinor)}</b>{product.stock!=null&&<span>Остаток {product.stock}</span>}</footer>
          </button>
          <button
            className={'product-favorite'+(favorite?' active':'')}
            aria-label={(favorite?'Убрать из избранного: ':'Добавить в избранное: ')+product.name}
            aria-pressed={favorite}
            onClick={()=>onToggleFavorite(product.id)}
          >★</button>
        </article>
      })}</div>}
  </section>
}
