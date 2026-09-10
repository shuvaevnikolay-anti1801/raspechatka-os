import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { BootState, PrintResult, SaleDetails } from '../../shared/contracts'
import type { DeviceHealth, PrintProvider } from './contracts'

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,(char)=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
}[char] as string))
const money=(minor:number)=>new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(minor/100)

type PrinterSettings={selectedPrinter?:string}

export class WindowsPrintProvider implements PrintProvider {
  constructor(private readonly settingsPath:string){}

  getSelectedPrinter():string|undefined{return this.loadSettings().selectedPrinter}

  async setSelectedPrinter(name:string):Promise<void>{
    const printers=await this.listPrinters()
    if(!printers.some((printer)=>printer.name===name))throw new Error(`Принтер «${name}» не найден в Windows`)
    writeFileSync(this.settingsPath,JSON.stringify({selectedPrinter:name} satisfies PrinterSettings),'utf-8')
  }

  async listPrinters():Promise<Array<{name:string;isDefault:boolean}>>{
    const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}})
    try{
      const printers=await window.webContents.getPrintersAsync()
      return printers.map((printer)=>({name:printer.name,isDefault:Boolean((printer as unknown as {isDefault?:boolean}).isDefault)}))
    }finally{window.destroy()}
  }

  async healthCheck():Promise<DeviceHealth>{
    const selected=this.getSelectedPrinter()
    if(!selected)return {ready:false,status:'not_configured',message:'Товарный принтер не выбран'}
    try{
      const printers=await this.listPrinters()
      if(printers.some((printer)=>printer.name===selected))return {ready:true,status:'ready',message:selected}
      return {ready:false,status:'offline',message:`Принтер «${selected}» сейчас недоступен`}
    }catch(error){
      return {ready:false,status:'error',message:error instanceof Error?error.message:String(error)}
    }
  }

  async printCommodityReceipt(sale:SaleDetails,boot:BootState):Promise<PrintResult> {
    const selected=this.getSelectedPrinter()
    if(!selected)throw new Error('Сначала выберите товарный принтер в настройках кассы')
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
      await new Promise<void>((resolve,reject)=>window.webContents.print({silent:true,deviceName:selected,printBackground:true},(success,reason)=>success?resolve():reject(new Error(reason||'Не удалось отправить товарный чек на принтер'))))
      return {kind:'commodity',status:'printed',message:`Товарный чек отправлен на ${selected}`}
    }finally{window.destroy()}
  }

  private loadSettings():PrinterSettings{
    if(!existsSync(this.settingsPath))return {}
    try{return JSON.parse(readFileSync(this.settingsPath,'utf-8')) as PrinterSettings}catch{return {}}
  }
}
