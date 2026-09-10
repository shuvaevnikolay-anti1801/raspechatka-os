import { useEffect } from 'react'

const isEditing=(target:EventTarget|null)=>{
  const element=target as HTMLElement|null
  if(!element)return false
  return ['INPUT','TEXTAREA','SELECT'].includes(element.tagName)||element.isContentEditable
}

const click=(selector:string)=>{
  const element=document.querySelector<HTMLButtonElement>(selector)
  if(element&&!element.disabled){element.click();return true}
  return false
}

export default function CashierHotkeys(){
  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{
      if(event.key==='F2'){
        event.preventDefault()
        const input=document.querySelector<HTMLInputElement>('.catalog-toolbar .search input')
        input?.focus();input?.select()
        return
      }
      if(event.key==='F4'){
        event.preventDefault()
        click('.receipt-actions .primary')
        return
      }
      if(event.key==='Escape'){
        const closeButton=document.querySelector<HTMLButtonElement>('.modal-backdrop header button, .safety-backdrop .safety-panel>header button')
        if(closeButton){event.preventDefault();closeButton.click()}
        return
      }
      if(event.ctrlKey&&!event.altKey&&!event.shiftKey&&['1','2','3','4','5','6'].includes(event.key)){
        event.preventDefault()
        const index=Number(event.key)-1
        document.querySelectorAll<HTMLButtonElement>('.main-nav>button')[index]?.click()
        return
      }
      if(event.key==='Enter'&&!isEditing(event.target)){
        const modalConfirm=document.querySelector<HTMLButtonElement>('.modal-backdrop button.primary.confirm:not(:disabled)')
        if(modalConfirm){event.preventDefault();modalConfirm.click()}
      }
    }
    window.addEventListener('keydown',handler)
    return()=>window.removeEventListener('keydown',handler)
  },[])
  return null
}
