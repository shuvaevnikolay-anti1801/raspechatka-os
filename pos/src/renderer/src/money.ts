const amountFormatter=new Intl.NumberFormat('ru-RU',{minimumFractionDigits:0,maximumFractionDigits:2})

export function formatMoney(minor:number):string {
  const value=Number.isFinite(minor)?minor/100:0
  const fraction=Math.abs(minor)%100
  return `${amountFormatter.format(value)} ₽`
}
