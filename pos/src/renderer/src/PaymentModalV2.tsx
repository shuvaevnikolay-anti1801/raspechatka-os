import { useEffect, useState } from 'react'
import type { BootState, PaymentMethod, PaymentPart, RemotePaymentConfirmation } from '../../shared/contracts'
import './checkout.css'
import { formatMoney } from './money'
import { PosButton } from './ui/PosButton'
import { PosField } from './ui/PosField'
import { PosModal } from './ui/PosModal'

export type PaymentChoice=PaymentMethod|'mixed'

const toMinor=(value:string)=>Math.round((Number(value.replace(',','.'))||0)*100)

export default function PaymentModalV2({choice,total,rules,busy,onChoice,onClose,onComplete}:{
  choice:PaymentChoice
  total:number
  rules:BootState['rules']
  busy:boolean
  onChoice:(choice:PaymentChoice)=>void
  onClose:()=>void
  onComplete:(payments:PaymentPart[],cashReceived?:number,remoteConfirmation?:RemotePaymentConfirmation)=>Promise<void>
}){
  const [cash,setCash]=useState('')
  const [card,setCard]=useState('')
  const [terminalReady,setTerminalReady]=useState(false)
  const [terminalMessage,setTerminalMessage]=useState('Проверяем терминал…')
  const [remoteConfirmed,setRemoteConfirmed]=useState(false)
  const [remoteNote,setRemoteNote]=useState('')

  useEffect(()=>{
    let active=true
    window.raspechatkaPos.getDeviceStatuses().then((devices)=>{
      if(!active)return
      setTerminalReady(devices.payment.ready)
      setTerminalMessage(devices.payment.message)
    }).catch((error)=>{
      if(!active)return
      setTerminalReady(false)
      setTerminalMessage(error instanceof Error?error.message:String(error))
    })
    return()=>{active=false}
  },[])

  const cashMinor=toMinor(cash)
  const cardMinor=toMinor(card)
  const mixedRemainder=Math.max(0,total-cashMinor-cardMinor)
  const terminalChoice=choice==='card'||choice==='qr'
  const remoteChoice=choice==='remote_payment'

  const submit=()=>{
    if(choice==='mixed'){
      const parts:PaymentPart[]=[]
      if(cashMinor)parts.push({method:'cash',amountMinor:cashMinor})
      if(cardMinor)parts.push({method:'card',amountMinor:cardMinor})
      if(mixedRemainder&&rules.acceptsQr)parts.push({method:'qr',amountMinor:mixedRemainder})
      return onComplete(parts,cashMinor)
    }
    const confirmation:RemotePaymentConfirmation|undefined=remoteChoice&&remoteConfirmed?{
      confirmed:true,confirmedAt:new Date().toISOString(),note:remoteNote.trim()||undefined
    }:undefined
    return onComplete([{method:choice,amountMinor:total}],choice==='cash'?(cashMinor||total):undefined,confirmation)
  }

  const mixedUsesTerminal=choice==='mixed'&&(cardMinor>0||(rules.acceptsQr&&mixedRemainder>0))
  const mixedValid=choice!=='mixed'||(
    cashMinor+cardMinor+(rules.acceptsQr?mixedRemainder:0)===total&&
    cashMinor+cardMinor<=total&&
    (cashMinor>0||cardMinor>0||mixedRemainder>0)&&
    (!mixedUsesTerminal||terminalReady)
  )
  const cashValid=choice!=='cash'||cashMinor===0||cashMinor>=total
  const canSubmit=!busy&&cashValid&&mixedValid&&(!terminalChoice||terminalReady)&&(!remoteChoice||remoteConfirmed)

  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!busy){
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if(event.key==='Enter'&&canSubmit){
        const target=event.target as HTMLElement|null
        if(target?.tagName==='TEXTAREA')return
        event.preventDefault()
        event.stopImmediatePropagation()
        void submit()
      }
    }
    window.addEventListener('keydown',handler,{capture:true})
    return()=>window.removeEventListener('keydown',handler,{capture:true})
  })

  return <PosModal
    open
    title="Выберите способ оплаты"
    layout="action"
    className="payment-modal-v2"
    closeLabel="Закрыть оплату"
    closeDisabled={busy}
    onClose={onClose}
    footer={<PosButton className="payment-confirm" variant="primary" size="touch" disabled={!canSubmit} onClick={()=>void submit()}>{busy?'Операция выполняется…':'Оплатить · '+formatMoney(total)}</PosButton>}
  >
    <div className="payment-amount-due"><span>К оплате</span><strong>{formatMoney(total)}</strong></div>

    <div className="checkout-methods" aria-label="Способы оплаты">
      <PosButton className={choice==='cash'?'active':''} onClick={()=>onChoice('cash')} disabled={busy||!rules.acceptsCash}><span>Наличные</span>{!rules.acceptsCash&&<small>Не принимается</small>}</PosButton>
      <PosButton className={choice==='card'?'active':''} onClick={()=>onChoice('card')} disabled={busy||!rules.acceptsCard||!terminalReady}><span>Карта</span>{!rules.acceptsCard?<small>Не принимается</small>:!terminalReady&&<small>Терминал не готов</small>}</PosButton>
      <PosButton className={choice==='qr'?'active':''} onClick={()=>onChoice('qr')} disabled={busy||!rules.acceptsQr||!terminalReady}><span>QR / СБП</span>{!rules.acceptsQr?<small>Не принимается</small>:!terminalReady&&<small>Терминал не готов</small>}</PosButton>
      <PosButton className={choice==='remote_payment'?'active':''} onClick={()=>onChoice('remote_payment')} disabled={busy||rules.acceptsRemotePayment===false}><span>Удалённая оплата</span><small>{rules.acceptsRemotePayment===false?'Не принимается':'По ссылке Точки'}</small></PosButton>
      <PosButton className={choice==='mixed'?'active':''} onClick={()=>onChoice('mixed')} disabled={busy}><span>Смешанная</span></PosButton>
    </div>

    <div className="payment-context">
      {(terminalChoice||mixedUsesTerminal)&&!terminalReady&&<div className="payment-warning">
        <strong>Эквайринг пока недоступен</strong>
        <span>{terminalMessage}. Деньги не будут считаться принятыми без ответа реального терминала.</span>
      </div>}

      {choice==='cash'&&<div className="cash-payment-context">
        <PosField label="Получено от клиента"><input autoFocus inputMode="decimal" value={cash} onChange={(event)=>setCash(event.target.value)} placeholder={formatMoney(total).replace(/\s₽$/,'')}/></PosField>
        <div className={'payment-change '+(cashMinor>0&&cashMinor<total?'invalid':'')}>
          <span>{cashMinor>0&&cashMinor<total?'Недостаточно':'Сдача'}</span>
          <strong>{cashMinor>0&&cashMinor<total?'Получено меньше суммы чека':formatMoney(Math.max(0,cashMinor-total))}</strong>
        </div>
      </div>}

      {remoteChoice&&<section className="remote-confirmation">
        <strong>Удалённая оплата по ссылке Точки</strong>
        <p>Проверьте подтверждение клиента или поступление денег. Касса не обращается к PAX и после подтверждения сразу перейдёт к фискальному чеку АТОЛ.</p>
        <label className="remote-check"><input type="checkbox" checked={remoteConfirmed} onChange={(event)=>setRemoteConfirmed(event.target.checked)} disabled={busy}/><span><b>Я проверил(а), что оплата действительно получена</b><small>Кассир и точное время подтверждения будут зафиксированы приложением.</small></span></label>
        <PosField label="Комментарий" helper="Необязательно"><input value={remoteNote} onChange={(event)=>setRemoteNote(event.target.value)} placeholder="Например: подтверждение в приложении Точки" disabled={busy}/></PosField>
      </section>}

      {choice==='mixed'&&<div className="split-payment">
        <div className="split-payment-fields">
          {rules.acceptsCash&&<PosField label="Наличными"><input autoFocus inputMode="decimal" value={cash} onChange={(event)=>setCash(event.target.value)} disabled={busy}/></PosField>}
          {rules.acceptsCard&&<PosField label="Картой"><input inputMode="decimal" value={card} onChange={(event)=>setCard(event.target.value)} disabled={busy||!terminalReady}/></PosField>}
          {rules.acceptsQr&&<div className="split-remainder"><span>QR — остаток</span><b>{formatMoney(mixedRemainder)}</b></div>}
        </div>
        <footer><span>Распределено</span><b>{formatMoney(cashMinor+cardMinor+(rules.acceptsQr?mixedRemainder:0))}</b></footer>
      </div>}
    </div>
  </PosModal>
}
