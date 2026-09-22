import { useId, type ReactNode } from 'react'
import { PosIconButton } from './PosButton'

export type PosModalLayout='form'|'action'|'matrix'
export function PosModal({open,title,onClose,children,footer,layout='form',className=''}:{
  open:boolean;title:string;onClose:()=>void;children:ReactNode;footer?:ReactNode;layout?:PosModalLayout;className?:string
}){
  const titleId=useId()
  if(!open)return null
  return <div className="pos-modal-backdrop">
    <section className={['pos-modal',`pos-modal--${layout}`,className].filter(Boolean).join(' ')} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="pos-modal__header"><h2 id={titleId}>{title}</h2><PosIconButton icon="close" label="Закрыть" variant="quiet"/></header>
      <div className="pos-modal__body">{children}</div>
      {footer&&<footer className="pos-modal__footer">{footer}</footer>}
    </section>
  </div>
}
