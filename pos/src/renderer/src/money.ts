const wholeFormatter=new Intl.NumberFormat('ru-RU',{minimumFractionDigits:0,maximumFractionDigits:0})
const fractionFormatter=new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})

export function formatMoney(minor:number):string {
  const value=Number.isFinite(minor)?minor/100:0
  const fraction=Math.abs(minor)%100
  const formatted=(fraction===0?wholeFormatter:fractionFormatter).format(value)
  return `${formatted} ₽`
}
