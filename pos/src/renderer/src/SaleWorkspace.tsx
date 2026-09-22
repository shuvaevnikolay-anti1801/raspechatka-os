import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  DEFAULT_SALE_PREFERENCES,
  clampSaleLayout,
  readSalePreferences,
  writeSalePreferences,
  type SaleLayoutRatios,
} from './sale-preferences'

type SaleWorkspaceProps={
  categories:ReactNode
  catalog:ReactNode
  receipt:ReactNode
}

type DragTarget='categories'|'receipt'

export default function SaleWorkspace({categories,catalog,receipt}:SaleWorkspaceProps){
  const rootRef=useRef<HTMLElement>(null)
  const [layout,setLayout]=useState<SaleLayoutRatios>(DEFAULT_SALE_PREFERENCES.layout)
  const preferencesRef=useRef(DEFAULT_SALE_PREFERENCES)

  useEffect(()=>{
    const root=rootRef.current
    if(!root)return
    const restore=()=>{
      const preferences=readSalePreferences(root.clientWidth)
      preferencesRef.current=preferences
      setLayout(preferences.layout)
    }
    restore()
    const observer=new ResizeObserver((entries)=>{
      const width=entries[0]?.contentRect.width??root.clientWidth
      setLayout((current)=>{
        const next=clampSaleLayout(current,width)
        preferencesRef.current={...preferencesRef.current,layout:next}
        writeSalePreferences(preferencesRef.current)
        return next
      })
    })
    observer.observe(root)
    return()=>observer.disconnect()
  },[])

  const resize=(target:DragTarget,event:ReactPointerEvent<HTMLDivElement>)=>{
    const root=rootRef.current
    if(!root)return
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds=root.getBoundingClientRect()
    const usable=Math.max(1,bounds.width-24)
    const candidate=target==='categories'
      ? {...layout,categoriesRatio:(event.clientX-bounds.left)/usable}
      : {...layout,receiptRatio:(bounds.right-event.clientX)/usable}
    const next=clampSaleLayout(candidate,bounds.width)
    preferencesRef.current={...preferencesRef.current,layout:next}
    setLayout(next)
    writeSalePreferences(preferencesRef.current)
  }

  return <main
    ref={rootRef}
    className="sale-workspace"
    style={{'--sale-categories-ratio':layout.categoriesRatio,'--sale-receipt-ratio':layout.receiptRatio} as React.CSSProperties}
  >
    <div className="sale-workspace-zone sale-workspace-categories">{categories}</div>
    <div className="sale-splitter" role="separator" aria-label="Изменить ширину категорий" aria-orientation="vertical" data-testid="sale-splitter" onPointerMove={(event)=>event.currentTarget.hasPointerCapture(event.pointerId)&&resize('categories',event)}/>
    <div className="sale-workspace-zone sale-workspace-catalog">{catalog}</div>
    <div className="sale-splitter" role="separator" aria-label="Изменить ширину чека" aria-orientation="vertical" data-testid="sale-splitter" onPointerMove={(event)=>event.currentTarget.hasPointerCapture(event.pointerId)&&resize('receipt',event)}/>
    <div className="sale-workspace-zone sale-workspace-receipt">{receipt}</div>
  </main>
}
