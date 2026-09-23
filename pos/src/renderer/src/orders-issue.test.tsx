import { readFileSync } from 'node:fs'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Order } from '../../shared/contracts'
import { IssueOrderConfirmation, runSingleOrderStatusUpdate } from './OrdersPage'

const readyOrder:Order={
  id:'order-ready-1',
  orderNumber:'ORD-READY-1',
  phone:'+7 900 111-22-33',
  contactMethod:'Telegram',
  lines:[],
  totalMinor:12500,
  paidMinor:12500,
  paymentStatus:'paid',
  status:'ready',
  comment:'Фотокнига',
  createdAt:'2026-09-23T10:15:00',
  dueAt:'2026-09-24T18:30:00',
  readyAt:'2026-09-24T17:00:00',
}

describe('DEV-172 stage 5 order issue confirmation',()=>{
  it('routes the issued action through confirmation instead of mutating immediately',()=>{
    const source=readFileSync(new URL('./OrdersPage.tsx',import.meta.url),'utf8')
    expect(source).toContain('onClick={()=>setIssuing(order)}>Выдан</PosButton>')
    expect(source).toContain('{issuing&&<IssueOrderConfirmation')
    expect(source).not.toContain("onClick={()=>void update(order,'issued')}")
  })

  it('renders the exact confirmation and disables confirm, cancel and close while pending',()=>{
    const markup=renderToStaticMarkup(
      <IssueOrderConfirmation order={readyOrder} pending={false} onConfirm={()=>undefined} onCancel={()=>undefined}/>,
    )
    expect(markup).toContain('Подтвердить выдачу заказа?')
    expect(markup).toMatch(/>Подтверждаю<\//)
    expect(markup).toMatch(/>Отмена<\//)
    expect(markup).toContain('ORD-READY-1')

    const pendingMarkup=renderToStaticMarkup(
      <IssueOrderConfirmation order={readyOrder} pending onConfirm={()=>undefined} onCancel={()=>undefined}/>,
    )
    expect((pendingMarkup.match(/disabled=""/g)||[]).length).toBeGreaterThanOrEqual(3)
  })

  it('cancel closes the confirmation without invoking the issue mutation',()=>{
    let confirmCalls=0
    let cancelCalls=0
    const modal=IssueOrderConfirmation({
      order:readyOrder,
      pending:false,
      onConfirm:()=>{confirmCalls+=1},
      onCancel:()=>{cancelCalls+=1},
    }) as ReactElement<{onClose:()=>void}>

    modal.props.onClose()
    expect(cancelCalls).toBe(1)
    expect(confirmCalls).toBe(0)
  })

  it('blocks a second update while the first promise is pending and releases after completion',async()=>{
    const pending=new Set<string>()
    let release:()=>void=()=>undefined
    const gate=new Promise<void>((resolve)=>{release=resolve})
    let updateCalls=0

    const first=runSingleOrderStatusUpdate(pending,readyOrder.id,async()=>{
      updateCalls+=1
      await gate
      return 'issued'
    })
    expect(pending.has(readyOrder.id)).toBe(true)

    const duplicate=await runSingleOrderStatusUpdate(pending,readyOrder.id,async()=>{
      updateCalls+=1
      return 'duplicate'
    })
    expect(duplicate).toEqual({started:false})
    expect(updateCalls).toBe(1)

    release()
    expect(await first).toEqual({started:true,value:'issued'})
    expect(pending.has(readyOrder.id)).toBe(false)
  })
})