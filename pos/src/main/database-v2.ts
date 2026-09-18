import { DatabaseSync } from 'node:sqlite'
import type { ShiftSummary } from '../shared/contracts'
import { PosDatabase } from './database'

export class PosDatabaseV2 extends PosDatabase {
  private readonly v2db:DatabaseSync

  constructor(filePath:string){
    super(filePath)
    this.v2db=new DatabaseSync(filePath)
    this.v2db.exec('PRAGMA journal_mode = WAL')
    this.ensureV2Column('sales','gross_minor','INTEGER NOT NULL DEFAULT 0')
    this.v2db.exec(`UPDATE sales SET gross_minor=COALESCE((
      SELECT SUM(ROUND(quantity*unit_price_minor)) FROM sale_items WHERE sale_items.sale_id=sales.id
    ),total_minor) WHERE gross_minor IS NULL OR gross_minor=0`)
  }

  override close():void{
    this.v2db.close()
    super.close()
  }

  private ensureV2Column(table:string,column:string,definition:string):void{
    const columns=this.v2db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>
    if(!columns.some((item)=>item.name===column)){
      this.v2db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  override saveSale(input:Parameters<PosDatabase['saveSale']>[0]):void{
    super.saveSale(input)
    const grossMinor=input.lines.reduce((sum,line)=>sum+Math.round(line.quantity*line.unitPriceMinor),0)
    this.v2db.prepare('UPDATE sales SET gross_minor=? WHERE id=?').run(grossMinor,input.id)
  }

  override getShiftSummary():ShiftSummary{
    const summary=super.getShiftSummary()
    const shift=this.currentShift()
    if(!shift)return {...summary,grossRevenueMinor:0,averageCheckBeforeDiscountMinor:0}
    const row=this.v2db.prepare(`SELECT COALESCE(SUM(CASE WHEN gross_minor>0 THEN gross_minor ELSE total_minor END),0) value
      FROM sales WHERE shift_id=?`).get(shift.id) as {value:number}
    const grossRevenueMinor=Number(row.value)||0
    return {
      ...summary,
      grossRevenueMinor,
      averageCheckBeforeDiscountMinor:summary.receipts?Math.round(grossRevenueMinor/summary.receipts):0
    }
  }
}
