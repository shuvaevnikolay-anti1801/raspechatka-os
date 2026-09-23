import { operatorError } from './operator-message'
import { useEffect, useRef, useState } from 'react'
import type { CompleteSaleResult, PaymentPart } from '../../shared/contracts'
import { formatMoney } from './money'
import { PosButton } from './ui/PosButton'
import { PosModal } from './ui/PosModal'
import { PosIcon } from './ui/PosIcon'

const paymentNames:Record<string,string>={cash:'Наличные',card:'Карта',qr:'QR / СБП',remote_payment:'Удалённая оплата'}
export const paymentSummary=(payments:readonly PaymentPart[])=>
  payments.map((payment)=>paymentNames[payment.method]||'Другой способ').join(' + ')||'—'

type Payload={
  result:CompleteSaleResult
  payments:PaymentPart[]
  createdAt:string
}

export default function SaleSuccessOverlay(){
  const [payload,setPayload]=useState<Payload|null>(null)
  const [printing,setPrinting]=useState(false)
  const printingRef=useRef(false)
  const [printError,setPrintError]=useState('')

  useEffect(()=>{
    const handler=(event:MessageEvent)=>{
      if(event.source!==window)return
      const data=event.data as {source?:string;type?:string;result?:CompleteSaleResult;payments?:PaymentPart[]}
      if(data?.source!=='raspechatka-pos'||data.type!=='sale-completed'||!data.result)return

      const saleId=data.result.saleId
      const fallbackCreatedAt=new Date().toISOString()
      printingRef.current=false
      setPrinting(false)
      setPrintError('')
      setPayload({result:data.result,payments:data.payments||[],createdAt:fallbackCreatedAt})

      void window.raspechatkaPos.getSale(saleId).then((sale)=>{
        setPayload((current)=>current?.result.saleId===saleId?{...current,createdAt:sale.createdAt}:current)
      }).catch(()=>undefined)
    }
    window.addEventListener('message',handler)
    return()=>window.removeEventListener('message',handler)
  },[])

  useEffect(()=>{
    if(!payload)return
    const handler=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement|null
      if(event.key==='Enter'&&!printing&&target?.tagName!=='BUTTON'){
        event.preventDefault()
        setPayload(null)
      }
    }
    window.addEventListener('keydown',handler)
    return()=>window.removeEventListener('keydown',handler)
  },[payload,printing])

  if(!payload)return null
  const {result,payments,createdAt}=payload

  const close=()=>setPayload(null)
  const printCommodity=async()=>{
    if(printingRef.current)return
    printingRef.current=true
    setPrinting(true)
    setPrintError('')
    try{
      await window.raspechatkaPos.printSale(result.saleId,'commodity')
      setPayload((current)=>current?.result.saleId===result.saleId?null:current)
    }catch(error){
      setPrintError(operatorError(error,'print'))
    }finally{
      printingRef.current=false
      setPrinting(false)
    }
  }

  return <PosModal
    open
    title="Оплата проведена"
    layout="action"
    className="sale-success-modal"
    onClose={close}
    footer={<div className="sale-success-actions">
      <PosButton autoFocus variant="primary" size="touch" className="sale-success-return" onClick={close}>Вернуться к продаже</PosButton>
      <PosButton variant="secondary" size="touch" className="sale-success-print" disabled={printing} onClick={()=>void printCommodity()}>{printing?'Печатаем…':'Напечатать товарный чек'}</PosButton>
    </div>}
  >
    <div className="sale-success-icon" aria-hidden="true"><PosIcon name="check"/></div>
    <dl className="sale-success-facts">
      <div><dt>Сумма</dt><dd className="sale-success-total">{formatMoney(result.totalMinor)}</dd></div>
      <div><dt>Способ оплаты</dt><dd>{paymentSummary(payments)}</dd></div>
      <div><dt>Сдача</dt><dd className={result.changeMinor?'change':''}>{result.changeMinor?formatMoney(result.changeMinor):'Без сдачи'}</dd></div>
      <div><dt>Номер чека</dt><dd>{result.receiptNumber}</dd></div>
      <div><dt>Дата и время</dt><dd>{new Date(createdAt).toLocaleString('ru-RU')}</dd></div>
    </dl>
    {printError&&<div className="sale-success-print-error" role="alert">{printError}</div>}
  </PosModal>
}
