import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { PosIcon, type PosIconName } from './PosIcon'

export type PosButtonVariant='primary'|'secondary'|'danger'|'quiet'
export type PosButtonSize='compact'|'control'|'touch'|'icon'
export type PosButtonProps=ButtonHTMLAttributes<HTMLButtonElement>&{
  variant?:PosButtonVariant
  size?:PosButtonSize
  icon?:ReactNode
}

export const PosButton=forwardRef<HTMLButtonElement,PosButtonProps>(function PosButton({
  variant='secondary',size='control',icon,children,className='',type='button',...props
},ref){
  return <button ref={ref} type={type} className={['pos-button',`pos-button--${variant}`,`pos-button--${size}`,className].filter(Boolean).join(' ')} {...props}>{icon}{children}</button>
})

export function PosIconButton({icon,label,className='',...props}:Omit<PosButtonProps,'children'|'icon'|'aria-label'|'title'>&{icon:PosIconName;label:string}){
  return <PosButton className={className} size="icon" aria-label={label} title={label} {...props}><PosIcon name={icon}/></PosButton>
}
