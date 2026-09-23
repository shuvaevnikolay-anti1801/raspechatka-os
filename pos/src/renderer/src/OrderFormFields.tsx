import type { CreateOrderFromSaleRequest, Order } from '../../shared/contracts'
import { PosField } from './ui/PosField'

export type OrderFormDraft={
  phone:string
  contactMethod:string
  dueAt:string
  comment:string
}

export type OrderFormPayload=Pick<CreateOrderFromSaleRequest,'phone'|'contactMethod'|'comment'|'dueAt'>

export const emptyOrderFormDraft=(phone=''):OrderFormDraft=>({phone,contactMethod:'',dueAt:'',comment:''})

export const orderFormDraftFromOrder=(order:Order):OrderFormDraft=>({
  phone:order.phone,
  contactMethod:order.contactMethod||'',
  dueAt:order.dueAt||'',
  comment:order.comment||'',
})

export const isCompleteOrderPhone=(value:string)=>value.replace(/\D/g,'').length===11

export const isOrderFormComplete=(draft:OrderFormDraft)=>
  isCompleteOrderPhone(draft.phone)&&Boolean(draft.comment.trim())&&Boolean(draft.dueAt)

export const toOrderFormPayload=(draft:OrderFormDraft):OrderFormPayload=>({
  phone:draft.phone.trim(),
  contactMethod:draft.contactMethod.trim()||undefined,
  comment:draft.comment.trim(),
  dueAt:draft.dueAt,
})

export function OrderFormFields({draft,onChange,autoFocusPhone=false,className=''}:{
  draft:OrderFormDraft
  onChange:(draft:OrderFormDraft)=>void
  autoFocusPhone?:boolean
  className?:string
}){
  const set=(next:Partial<OrderFormDraft>)=>onChange({...draft,...next})
  return <div className={['order-form-fields',className].filter(Boolean).join(' ')} data-order-form-fields>
    <PosField label="Телефон *" error={draft.phone&&!isCompleteOrderPhone(draft.phone)?'Введите полный номер из 11 цифр':undefined}>
      <input autoFocus={autoFocusPhone} inputMode="tel" value={draft.phone} onChange={(event)=>set({phone:event.target.value})} placeholder="+7 900 000-00-00"/>
    </PosField>
    <PosField label="Способ связи">
      <input value={draft.contactMethod} onChange={(event)=>set({contactMethod:event.target.value})} placeholder="Например, Telegram или звонок"/>
    </PosField>
    <PosField label="Дата выдачи *">
      <input type="datetime-local" value={draft.dueAt} onChange={(event)=>set({dueAt:event.target.value})}/>
    </PosField>
    <PosField label="Описание заказа *" size="textarea" className="order-description-field">
      <textarea value={draft.comment} onChange={(event)=>set({comment:event.target.value})} placeholder="Что нужно изготовить"/>
    </PosField>
  </div>
}
