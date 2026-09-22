import { useEffect, useState } from 'react'
import type { BootState, PaymentMethod, PaymentPart, RemotePaymentConfirmation } from '../../shared/contracts'
import './checkout.css'
import { formatMoney } from './money'

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

  return <div className="modal-backdrop payment-backdrop"><div className="payment-modal payment-modal-v2" role="dialog" aria-modal="true" aria-labelledby="payment-title">
    <header className="payment-heading">
      <div><small>ОПЛАТА</small><h2 id="payment-title">Выберите способ оплаты</h2></div>
      <button className="payment-close" aria-label="Закрыть оплату" onClick={onClose} disabled={busy}>×</button>
    </header>

    <div className="payment-amount-due"><span>К оплате</span><strong>{formatMoney(total)}</strong></div>

    <div className="method-grid checkout-methods" aria-label="Способы оплаты">
      {rules.acceptsCash&&<button className={choice==='cash'?'active':''} onClick={()=>onChoice('cash')} disabled={busy}><span>Наличные</span></button>}
      {rules.acceptsCard&&<button className={choice==='card'?'active':''} onClick={()=>onChoice('card')} disabled={busy||!terminalReady}><span>Карта</span>{!terminalReady&&<small>Терминал не готов</small>}</button>}
      {rules.acceptsQr&&<button className={choice==='qr'?'active':''} onClick={()=>onChoice('qr')} disabled={busy||!terminalReady}><span>QR / СБП</span>{!terminalReady&&<small>Терминал не готов</small>}</button>}
      {rules.acceptsRemotePayment!==false&&<button className={choice==='remote_payment'?'active':''} onClick={()=>onChoice('remote_payment')} disabled={busy}><span>Удалённая оплата</span><small>По ссылке Точки</small></button>}
      <button className={choice==='mixed'?'active':''} onClick={()=>onChoice('mixed')} disabled={busy}><span>Смешанная</span></button>
    </div>

    <div className="payment-context">
      {(terminalChoice||mixedUsesTerminal)&&!terminalReady&&<div className="payment-warning">
        <strong>Эквайринг пока недоступен</strong>
        <span>{terminalMessage}. Деньги не будут считаться принятыми без ответа реального терминала.</span>
      </div>}

      {choice==='cash'&&<div className="cash-payment-context">
        <label className="cash-input payment-received"><span>Получено от клиента</span><input autoFocus inputMode="decimal" value={cash} onChange={(event)=>setCash(event.target.value)} placeholder={formatMoney(total).replace(/\s₽$/,'')}/></label>
        <div className={'payment-change '+(cashMinor>0&&cashMinor<total?'invalid':'')}>
          <span>{cashMinor>0&&cashMinor<total?'Недостаточно':'Сдача'}</span>
          <strong>{cashMinor>0&&cashMinor<total?'Получено меньше суммы чека':formatMoney(Math.max(0,cashMinor-total))}</strong>
        </div>
      </div>}

      {remoteChoice&&<section className="remote-confirmation">
        <strong>Удалённая оплата по ссылке Точки</strong>
        <p>Проверьте подтверждение клиента или поступление денег. Касса не обращается к PAX и после подтверждения сразу перейдёт к фискальному чеку АТОЛ.</p>
        <label className="remote-check"><input type="checkbox" checked={remoteConfirmed} onChange={(event)=>setRemoteConfirmed(event.target.checked)} disabled={busy}/><span><b>Я проверил(а), что оплата действительно получена</b><small>Кассир и точное время подтверждения будут зафиксированы приложением.</small></span></label>
        <label className="cash-input"><span>Комментарий (необязательно)</span><input value={remoteNote} onChange={(event)=>setRemoteNote(event.target.value)} placeholder="Например: подтверждение в приложении Точки" disabled={busy}/></label>
      </section>}

      {choice==='mixed'&&<div className="split-payment">
        <p>Укажите, сколько клиент платит каждым способом.</p>
        <div className="split-payment-fields">
          {rules.acceptsCash&&<label><span>Наличными</span><input autoFocus inputMode="decimal" value={cash} onChange={(event)=>setCash(event.target.value)} disabled={busy}/></label>}
          {rules.acceptsCard&&<label><span>Картой</span><input inputMode="decimal" value={card} onChange={(event)=>setCard(event.target.value)} disabled={busy||!terminalReady}/></label>}
          {rules.acceptsQr&&<div className="split-remainder"><span>QR — остаток</span><b>{formatMoney(mixedRemainder)}</b></div>}
        </div>
        <footer><span>Распределено</span><b>{formatMoney(cashMinor+cardMinor+(rules.acceptsQr?mixedRemainder:0))}</b></footer>
      </div>}
    </div>

    <footer className="payment-actions">
      <button className="primary confirm payment-confirm" disabled={!canSubmit} onClick={()=>void submit()}>{busy?'Операция выполняется…':'Подтвердить · '+formatMoney(total)}</button>
      <p className="checkout-footnote">Enter — подтвердить · Esc — закрыть. После начала операции повторное нажатие блокируется. При сбое касса сохранит состояние и предложит безопасное восстановление.</p>
    </footer>
  </div></div>
}
