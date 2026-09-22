import type { ReactNode } from 'react'

export function PinInput({value,onChange,autoFocus=false,ariaLabel}:{value:string;onChange:(value:string)=>void;autoFocus?:boolean;ariaLabel:string}){
  const numeric=(next:string)=>next.replace(/\D/g,'').slice(0,4)
  return <div className="pin-input" data-filled={value.length>0}>
    <input
      className="cashier-pin-input pin-input-control"
      autoFocus={autoFocus}
      type="password"
      inputMode="numeric"
      pattern="[0-9]{4}"
      maxLength={4}
      value={value}
      aria-label={ariaLabel}
      onChange={(event)=>onChange(numeric(event.target.value))}
    />
    <div className="pin-input-slots" aria-hidden="true">
      {[0,1,2,3].map((slot)=><span className={slot<value.length?'filled':''} key={slot}>{slot<value.length?'•':''}</span>)}
    </div>
  </div>
}

export function PinEntryLayout({
  children,
  footerLeft,
  footerRight,
}:{children:ReactNode;footerLeft:ReactNode;footerRight?:ReactNode}){
  return <div className="pin-entry-layout">
    <div className="pin-entry-main"><div className="pin-entry-content">{children}</div></div>
    <div className="pin-entry-footer">
      <div className="pin-entry-footer-left">{footerLeft}</div>
      <div className="pin-entry-footer-right">{footerRight}</div>
    </div>
  </div>
}
