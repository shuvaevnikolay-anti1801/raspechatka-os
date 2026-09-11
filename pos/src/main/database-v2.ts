import { DatabaseSync } from 'node:sqlite'
import type { Customer, ShiftSummary } from '../shared/contracts'
import { PosDatabase } from './database'

export class PosDatabaseV2 extends PosDatabase {
  private readonly v2db:DatabaseSync

  constructor(filePath:string){
    super(filePath)
    this.v2db=new DatabaseSync(filePath)
    this.v2db.exec('PRAGMA journal_mode = WAL')
    this.ensureV2Column('customers','club_status','TEXT')
    this.ensureV2Column('customers','is_club_member','INTEGER NOT NULL DEFAULT 0')
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

  override listCustomers(query=''):Customer[]{
    const q=`%${query}%`
    return this.v2db.prepare(`SELECT id,name,phone,discount_percent AS discountPercent,
      purchase_count AS purchaseCount,total_spent_minor AS totalSpentMinor,
      club_status AS clubStatus,is_club_member AS isClubMember
      FROM customers WHERE active=1 AND (name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 50`)
      .all(q,q).map((row:any)=>({...row,isClubMember:Number(row.isClubMember)||0})) as Customer[]
  }

  override replaceCustomers(customers:Customer[]):void{
    super.replaceCustomers(customers)
    const update=this.v2db.prepare('UPDATE customers SET club_status=?,is_club_member=? WHERE id=?')
    this.v2db.exec('BEGIN')
    try{
      customers.forEach((customer)=>update.run(customer.clubStatus??null,customer.isClubMember?1:0,customer.id))
      this.v2db.exec('COMMIT')
    }catch(error){
      this.v2db.exec('ROLLBACK')
      throw error
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
