import { BrowserWindow } from 'electron'
import type { BootState, PrintResult, SaleDetails } from '../../shared/contracts'
import type { PrintProvider } from './contracts'

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,(char)=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
}[char] as string))
const money=(minor:number)=>new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(minor/100)

export class WindowsPrintProvider implements PrintProvider {
  async printCommodityReceipt(sale:SaleDetails,boot:BootState):Promise<PrintResult> {
    const rows=sale.lines.map((line)=>`<tr><td>${escapeHtml(line.name)}</td><td>${line.quantity}</td><td>${money(line.unitPriceMinor)}</td><td>${money(line.quantity*line.unitPriceMinor)}</td></tr>`).join('')
    const html=`<!doctype html><html><head><meta charset="utf-8"><title>Товарный чек ${escapeHtml(sale.receiptNumber)}</title>
      <style>@page{size:A4;margin:16mm}body{font:13px Arial;color:#222}h1{font-size:20px}small{color:#666}
      table{width:100%;border-collapse:collapse;margin:22px 0}th,td{border:1px solid #bbb;padding:8px;text-align:left}th:nth-child(n+2),td:nth-child(n+2){text-align:right}
      .total{text-align:right;font-size:18px;font-weight:700}.sign{margin-top:60px}</style></head><body>
      <h1>Товарный чек № ${escapeHtml(sale.receiptNumber)}</h1>
      <p><b>${escapeHtml(boot.pointName)}</b><br><small>${escapeHtml(boot.workstationName)} · ${new Date(sale.createdAt).toLocaleString('ru-RU')}</small></p>
      <p>Покупатель: ${escapeHtml(sale.customerName||'Розничный покупатель')}</p>
      <table><thead><tr><th>Наименование</th><th>Количество</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="total">Итого: ${money(sale.totalMinor)} ₽</p><p class="sign">Отпустил: ____________________ / ${escapeHtml(boot.cashierName)}</p>
      </body></html>`
    const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}})
    try{
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      await new Promise<void>((resolve,reject)=>window.webContents.print({silent:false,printBackground:true},(success,reason)=>success?resolve():reject(new Error(reason||'Печать отменена'))))
      return {kind:'commodity',status:'printed',message:'Товарный чек отправлен на выбранный принтер'}
    }finally{window.destroy()}
  }
}
