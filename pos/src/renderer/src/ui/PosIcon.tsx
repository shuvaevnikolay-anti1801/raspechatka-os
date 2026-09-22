import type { ReactElement, SVGProps } from 'react'

export type PosIconName=
  |'sale'|'receipts'|'orders'|'shift'|'work'|'settings'
  |'search'|'refresh'|'lock'|'trash'|'hold'|'order'|'close'
  |'star'|'inventory'|'plus'|'minus'|'check'

const paths:Record<PosIconName,ReactElement>={
  sale:<><path d="M4 7h16l-1 13H5L4 7Z"/><path d="M8 7a4 4 0 0 1 8 0"/></>,
  receipts:<><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
  orders:<><path d="M6 4h12v16H6z"/><path d="M9 4V2h6v2M9 9h6M9 13h6M9 17h4"/></>,
  shift:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  work:<><path d="M3 7h18v13H3z"/><path d="M9 7V4h6v3M3 12h18M10 12v2h4v-2"/></>,
  settings:<><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></>,
  search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  refresh:<><path d="M20 7v5h-5"/><path d="M18.5 16A8 8 0 1 1 20 12"/></>,
  lock:<><rect x="5" y="10" width="14" height="11"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  trash:<><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
  hold:<><path d="M8 5v14M16 5v14"/></>,
  order:<><path d="M6 3h12v18H6zM9 8h6M9 12h6"/><path d="M12 15v4M10 17h4"/></>,
  close:<path d="m6 6 12 12M18 6 6 18"/>,
  star:<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>,
  inventory:<><path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/></>,
  plus:<path d="M12 5v14M5 12h14"/>,
  check:<path d="m5 12 4 4L19 6"/>,
  minus:<path d="M5 12h14"/>,
}

export function PosIcon({name,className='',...props}:{name:PosIconName}&SVGProps<SVGSVGElement>){
  return <svg className={['pos-icon',className].filter(Boolean).join(' ')} data-pos-icon={name} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>
}
