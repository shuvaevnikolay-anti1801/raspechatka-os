import { useEffect, useState } from 'react'
import type { BootState, PaymentMethod, PaymentPart, RemotePaymentConfirmation } from '../../shared/contracts'
import './checkout.css'

export type PaymentChoice=PaymentMethod|'mixed'

const money=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2})
const formatMoney=(minor:number)=>money.format(minor/100)
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
  const canSubmit=!busy&&mixedValid&&(!terminalChoice||terminalReady)&&(!remoteChoice||remoteConfirmed)

  return <div className="modal-backdrop"><div className="payment-modal payment-modal-v2">
    <header><div><small>ОПЛАТА</small><h2>{formatMoney(total)}</h2></div><button onClick={onClose} disabled={busy}>×</button></header>
    <div className="method-grid checkout-methods">
      {rules.acceptsCash&&<button className={choice==='cash'?'active':''} onClick={()=>onChoice('cash')} disabled={busy}>Наличные</button>}
      {rules.acceptsCard&&<button className={choice==='card'?'active':''} onClick={()=>onChoice('card')} disabled={busy||!terminalReady}>Карта{!terminalReady&&<small>Терминал не готов</small>}</button>}
      {rules.acceptsQr&&<button className={choice==='qr'?'active':''} onClick={()=>onChoice('qr')} disabled={busy||!terminalReady}>QR / СБП{!terminalReady&&<small>Терминал не готов</small>}</button>}
      {rules.acceptsRemotePayment!==false&&<button className={choice==='remote_payment'?'active':''} onClick={()=>onChoice('remote_payment')} disabled={busy}>Удалённая оплата<small>По ссылке Точки</small></button>}
      <button className={choice==='mixed'?'active':''} onClick={()=>onChoice('mixed')} disabled={busy}>Смешанная</button>
    </div>

    {(terminalChoice||mixedUsesTerminal)&&!terminalReady&&<div className="payment-warning"><strong>Эквайринг пока недоступен</strong><span>{terminalMessage}. Деньги не будут считаться принятыми без ответа реального терминала.</span></div>}

    {choice==='cash'&&<label className="cash-input"><span>Получено от клиента</span><input autoFocus value={cash} onChange={(e)=>setCash(e.target.value)} placeholder={(total/100).toFixed(2)}/><small>Сдача: {formatMoney(Math.max(0,cashMinor-total))}</small></label>}

    {remoteChoice&&<section className="remote-confirmation">
      <strong>Удалённая оплата по ссылке Точки</strong>
      <p>Проверьте подтверждение клиента или поступление денег. Касса не обращается к PAX и после подтверждения сразу перейдёт к фискальному чеку АТОЛ.</p>
      <label className="remote-check"><input type="checkbox" checked={remoteConfirmed} onChange={(e)=>setRemoteConfirmed(e.target.checked)} disabled={busy}/><span><b>Я проверил(а), что оплата действительно получена</b><small>Кассир и точное время подтверждения будут зафиксированы приложением.</small></span></label>
      <label className="cash-input"><span>Комментарий (необязательно)</span><input value={remoteNote} onChange={(e)=>setRemoteNote(e.target.value)} placeholder="Например: подтверждение в приложении Точки" disabled={busy}/></label>
    </section>}

    {choice==='mixed'&&<div className="split-payment"><p>Укажите, сколько клиент платит каждым способом.</p>{rules.acceptsCash&&<label><span>Наличными</span><input value={cash} onChange={(e)=>setCash(e.target.value)} disabled={busy}/></label>}{rules.acceptsCard&&<label><span>Картой</span><input value={card} onChange={(e)=>setCard(e.target.value)} disabled={busy||!terminalReady}/></label>}{rules.acceptsQr&&<div><span>QR — остаток</span><b>{formatMoney(mixedRemainder)}</b></div>}<footer><span>Распределено</span><b>{formatMoney(cashMinor+cardMinor+(rules.acceptsQr?mixedRemainder:0))}</b></footer></div>}

    <button className="primary confirm" disabled={!canSubmit} onClick={submit}>{busy?'Операция выполняется…':'Подтвердить · '+formatMoney(total)}</button>
    <p className="checkout-footnote">После начала операции повторное нажатие блокируется. При сбое касса сохранит состояние и предложит безопасное восстановление.</p>
  </div></div>
}
