import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type CSSProperties, type ReactNode } from 'react'
import {
  DEFAULT_SALE_PREFERENCES,
  clampSaleLayout,
  pruneFavoriteProductIds,
  readSalePreferences,
  toggleFavoriteProductId,
  writeSalePreferences,
  type SalePreferencesV1,
} from './sale-preferences'

type FavoritesRender=(favoriteProductIds:readonly string[],onToggleFavorite:(productId:string)=>void)=>ReactNode
type SaleWorkspaceProps={
  categories:FavoritesRender
  catalog:FavoritesRender
  receipt:ReactNode
  productIds:readonly string[]
}

type DragTarget='categories'|'receipt'

export default function SaleWorkspace({categories,catalog,receipt,productIds}:SaleWorkspaceProps){
  const rootRef=useRef<HTMLElement>(null)
  const preferencesRef=useRef<SalePreferencesV1>(DEFAULT_SALE_PREFERENCES)
  const [preferences,setPreferences]=useState<SalePreferencesV1>(DEFAULT_SALE_PREFERENCES)
  const productIdsKey=productIds.join('\u0000')

  const commitPreferences=(next:SalePreferencesV1)=>{
    preferencesRef.current=next
    setPreferences(next)
    writeSalePreferences(next)
  }

  useEffect(()=>{
    const root=rootRef.current
    if(!root)return
    const restored=readSalePreferences(root.clientWidth)
    commitPreferences({...restored,favoriteProductIds:pruneFavoriteProductIds(restored.favoriteProductIds,productIds)})
    const observer=new ResizeObserver((entries)=>{
      const width=entries[0]?.contentRect.width??root.clientWidth
      const current=preferencesRef.current
      commitPreferences({...current,layout:clampSaleLayout(current.layout,width)})
    })
    observer.observe(root)
    return()=>observer.disconnect()
  },[])

  useEffect(()=>{
    const current=preferencesRef.current
    const favoriteProductIds=pruneFavoriteProductIds(current.favoriteProductIds,productIds)
    if(favoriteProductIds.length!==current.favoriteProductIds.length)commitPreferences({...current,favoriteProductIds})
  },[productIdsKey])

  const resize=(target:DragTarget,event:ReactPointerEvent<HTMLDivElement>)=>{
    const root=rootRef.current
    if(!root)return
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds=root.getBoundingClientRect()
    const usable=Math.max(1,bounds.width-24)
    const current=preferencesRef.current
    const candidate=target==='categories'
      ? {...current.layout,categoriesRatio:(event.clientX-bounds.left)/usable}
      : {...current.layout,receiptRatio:(bounds.right-event.clientX)/usable}
    commitPreferences({...current,layout:clampSaleLayout(candidate,bounds.width)})
  }

  const toggleFavorite=(productId:string)=>{
    const current=preferencesRef.current
    commitPreferences({...current,favoriteProductIds:toggleFavoriteProductId(current.favoriteProductIds,productId)})
  }

  return <main
    ref={rootRef}
    className="sale-workspace"
    style={{'--sale-categories-ratio':preferences.layout.categoriesRatio,'--sale-receipt-ratio':preferences.layout.receiptRatio} as CSSProperties}
  >
    <div className="sale-workspace-zone sale-workspace-categories">{categories(preferences.favoriteProductIds,toggleFavorite)}</div>
    <div className="sale-splitter" role="separator" aria-label="Изменить ширину категорий" aria-orientation="vertical" data-testid="sale-splitter" onPointerDown={(event)=>{event.currentTarget.setPointerCapture(event.pointerId);resize('categories',event)}} onPointerMove={(event)=>event.currentTarget.hasPointerCapture(event.pointerId)&&resize('categories',event)}/>
    <div className="sale-workspace-zone sale-workspace-catalog">{catalog(preferences.favoriteProductIds,toggleFavorite)}</div>
    <div className="sale-splitter" role="separator" aria-label="Изменить ширину чека" aria-orientation="vertical" data-testid="sale-splitter" onPointerDown={(event)=>{event.currentTarget.setPointerCapture(event.pointerId);resize('receipt',event)}} onPointerMove={(event)=>event.currentTarget.hasPointerCapture(event.pointerId)&&resize('receipt',event)}/>
    <div className="sale-workspace-zone sale-workspace-receipt">{receipt}</div>
  </main>
}
