import { cloneElement, useId, type ReactElement, type ReactNode } from 'react'

type FieldControlProps={id?:string;'aria-describedby'?:string;'aria-invalid'?:boolean}
export function PosField({label,children,error,helper,size='default',className=''}:{
  label:string;children:ReactElement<FieldControlProps>;error?:string;helper?:ReactNode;size?:'default'|'textarea';className?:string
}){
  const generatedId=useId()
  const controlId=children.props.id||generatedId
  const messageId=(error||helper)?`${controlId}-message`:undefined
  const control=cloneElement(children,{id:controlId,'aria-describedby':messageId,'aria-invalid':Boolean(error)||undefined})
  return <label className={['pos-field',`pos-field--${size}`,error?'pos-field--error':'',className].filter(Boolean).join(' ')} htmlFor={controlId}>
    <span className="pos-field__label">{label}</span>
    {control}
    {(error||helper)&&<span id={messageId} className={error?'pos-field__error':'pos-field__helper'}>{error||helper}</span>}
  </label>
}
