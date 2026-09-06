import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { CartLine, Customer, HeldReceipt, Product, SaleSummary, Shift, ShiftSummary } from '../shared/contracts'

export class PosDatabase {
  private readonly db: DatabaseSync

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
    this.seedDemoData()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT 'service',
        uom TEXT NOT NULL DEFAULT 'шт', barcode TEXT, stock REAL,
        price_minor INTEGER NOT NULL CHECK(price_minor >= 0), active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT,
        discount_percent REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT, cashier_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL UNIQUE, shift_id TEXT NOT NULL,
        total_minor INTEGER NOT NULL, payment_method TEXT NOT NULL,
        payment_transaction_id TEXT NOT NULL, fiscal_number TEXT NOT NULL,
        customer_name TEXT, status TEXT NOT NULL DEFAULT 'completed', created_at TEXT NOT NULL,
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
      );
      CREATE TABLE IF NOT EXISTS sale_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id TEXT NOT NULL, product_id TEXT NOT NULL,
        name TEXT NOT NULL, quantity REAL NOT NULL, unit_price_minor INTEGER NOT NULL,
        discount_percent REAL NOT NULL DEFAULT 0, FOREIGN KEY (sale_id) REFERENCES sales(id)
      );
      CREATE TABLE IF NOT EXISTS held_receipts (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL, sent_at TEXT
      );
    `)
    this.ensureColumn('products', 'item_type', "TEXT NOT NULL DEFAULT 'service'")
    this.ensureColumn('products', 'uom', "TEXT NOT NULL DEFAULT 'шт'")
    this.ensureColumn('products', 'barcode', 'TEXT')
    this.ensureColumn('products', 'stock', 'REAL')
    this.ensureColumn('sales', 'customer_name', 'TEXT')
    this.ensureColumn('sales', 'status', "TEXT NOT NULL DEFAULT 'completed'")
    this.ensureColumn('sale_items', 'discount_percent', 'REAL NOT NULL DEFAULT 0')
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private seedDemoData(): void {
    const insertProduct = this.db.prepare(`INSERT OR IGNORE INTO products
      (id,name,sku,category,item_type,uom,barcode,stock,price_minor) VALUES (?,?,?,?,?,?,?,?,?)`)
    const products: Product[] = [
      { id:'print-bw-a4', name:'Печать ч/б A4', sku:'SVC-001', category:'Печать', type:'service', uom:'лист', priceMinor:2000 },
      { id:'print-color-a4', name:'Печать цветная A4', sku:'SVC-002', category:'Печать', type:'service', uom:'лист', priceMinor:4000 },
      { id:'scan-a4', name:'Сканирование A4', sku:'SVC-003', category:'Документы', type:'service', uom:'лист', priceMinor:5000 },
      { id:'photo-docs', name:'Фото на документы', sku:'SVC-004', category:'Фото', type:'service', uom:'комплект', priceMinor:45000 },
      { id:'lamination-a4', name:'Ламинирование A4', sku:'SVC-005', category:'Документы', type:'service', uom:'лист', priceMinor:8000 },
      { id:'envelope-c5', name:'Конверт C5', sku:'PRD-001', category:'Товары', type:'product', uom:'шт', barcode:'460000000001', stock:24, priceMinor:2500 },
      { id:'mug-print', name:'Кружка с печатью', sku:'BND-001', category:'Подарки', type:'bundle', uom:'шт', priceMinor:79000 },
      { id:'binding', name:'Переплёт документа', sku:'SVC-006', category:'Документы', type:'service', uom:'шт', priceMinor:25000 }
    ]
    this.db.exec('BEGIN')
    try {
      products.forEach((p) => insertProduct.run(p.id,p.name,p.sku,p.category,p.type,p.uom,p.barcode ?? null,p.stock ?? null,p.priceMinor))
      const insertCustomer = this.db.prepare('INSERT OR IGNORE INTO customers (id,name,phone,discount_percent) VALUES (?,?,?,?)')
      insertCustomer.run('retail','Розничный покупатель',null,0)
      insertCustomer.run('demo-client','Елена','+7 900 000-00-00',5)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  listProducts(): Product[] {
    return this.db.prepare(`SELECT id,name,sku,category,item_type AS type,uom,barcode,stock,
      price_minor AS priceMinor FROM products WHERE active=1 ORDER BY category,name`).all() as Product[]
  }

  replaceProducts(products: Product[]): void {
    const upsert = this.db.prepare(`INSERT INTO products
      (id,name,sku,category,item_type,uom,barcode,stock,price_minor,active) VALUES (?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,sku=excluded.sku,category=excluded.category,
      item_type=excluded.item_type,uom=excluded.uom,barcode=excluded.barcode,stock=excluded.stock,
      price_minor=excluded.price_minor,active=1`)
    this.db.exec('BEGIN')
    try {
      products.forEach((p) => upsert.run(p.id,p.name,p.sku,p.category,p.type,p.uom,p.barcode ?? null,p.stock ?? null,p.priceMinor))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  listCustomers(query=''): Customer[] {
    const value=`%${query}%`
    return this.db.prepare(`SELECT id,name,phone,discount_percent AS discountPercent FROM customers
      WHERE active=1 AND (name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 50`).all(value,value) as Customer[]
  }

  currentShift(): Shift | null {
    return (this.db.prepare(`SELECT id,opened_at AS openedAt,closed_at AS closedAt,cashier_name AS cashierName
      FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`).get() as Shift | undefined) ?? null
  }

  openShift(shift: Shift): Shift {
    const current=this.currentShift(); if(current) return current
    this.db.prepare('INSERT INTO shifts (id,opened_at,cashier_name) VALUES (?,?,?)').run(shift.id,shift.openedAt,shift.cashierName)
    return shift
  }

  closeShift(): ShiftSummary {
    const current=this.currentShift(); if(!current) throw new Error('Нет открытой смены')
    const summary=this.getShiftSummary()
    this.db.prepare('UPDATE shifts SET closed_at=? WHERE id=?').run(new Date().toISOString(),current.id)
    return summary
  }

  getShiftSummary(): ShiftSummary {
    const current=this.currentShift()
    if(!current) return { receipts:0,revenueMinor:0,cashMinor:0,cardMinor:0,qrMinor:0 }
    return this.db.prepare(`SELECT COUNT(*) receipts,COALESCE(SUM(total_minor),0) revenueMinor,
      COALESCE(SUM(CASE WHEN payment_method='cash' THEN total_minor ELSE 0 END),0) cashMinor,
      COALESCE(SUM(CASE WHEN payment_method='card' THEN total_minor ELSE 0 END),0) cardMinor,
      COALESCE(SUM(CASE WHEN payment_method='qr' THEN total_minor ELSE 0 END),0) qrMinor
      FROM sales WHERE shift_id=? AND status='completed'`).get(current.id) as ShiftSummary
  }

  findSaleByClientRequestId(clientRequestId: string): { saleId:string;receiptNumber:string;totalMinor:number } | null {
    return (this.db.prepare('SELECT id saleId,fiscal_number receiptNumber,total_minor totalMinor FROM sales WHERE client_request_id=?').get(clientRequestId) as { saleId:string;receiptNumber:string;totalMinor:number }|undefined) ?? null
  }

  saveSale(input:{id:string;clientRequestId:string;shiftId:string;totalMinor:number;paymentMethod:string;paymentTransactionId:string;fiscalNumber:string;createdAt:string;customerName?:string;lines:CartLine[]}):void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`INSERT INTO sales (id,client_request_id,shift_id,total_minor,payment_method,payment_transaction_id,fiscal_number,customer_name,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(input.id,input.clientRequestId,input.shiftId,input.totalMinor,input.paymentMethod,input.paymentTransactionId,input.fiscalNumber,input.customerName ?? null,input.createdAt)
      const insert=this.db.prepare('INSERT INTO sale_items (sale_id,product_id,name,quantity,unit_price_minor,discount_percent) VALUES (?,?,?,?,?,?)')
      input.lines.forEach((l)=>insert.run(input.id,l.productId,l.name,l.quantity,l.unitPriceMinor,l.discountPercent ?? 0))
      this.db.prepare("INSERT INTO outbox (id,event_type,payload_json,created_at) VALUES (?,'sale.completed',?,?)").run(randomUUID(),JSON.stringify(input),input.createdAt)
      this.db.exec('COMMIT')
    } catch(error){this.db.exec('ROLLBACK');throw error}
  }

  listSales(): SaleSummary[] {
    return this.db.prepare(`SELECT id,fiscal_number receiptNumber,total_minor totalMinor,payment_method paymentMethod,
      customer_name customerName,created_at createdAt,status FROM sales ORDER BY created_at DESC LIMIT 100`).all() as SaleSummary[]
  }

  holdReceipt(input:Omit<HeldReceipt,'id'|'createdAt'>):HeldReceipt {
    const receipt={...input,id:randomUUID(),createdAt:new Date().toISOString()}
    this.db.prepare('INSERT INTO held_receipts (id,label,payload_json,created_at) VALUES (?,?,?,?)').run(receipt.id,receipt.label,JSON.stringify(receipt),receipt.createdAt)
    return receipt
  }
  listHeldReceipts():HeldReceipt[]{return (this.db.prepare('SELECT payload_json payload FROM held_receipts ORDER BY created_at DESC').all() as Array<{payload:string}>).map((r)=>JSON.parse(r.payload) as HeldReceipt)}
  deleteHeldReceipt(id:string):void{this.db.prepare('DELETE FROM held_receipts WHERE id=?').run(id)}
  pendingSyncCount():number{return (this.db.prepare('SELECT COUNT(*) count FROM outbox WHERE sent_at IS NULL').get() as {count:number}).count}
  setState(key:string,value:string):void{this.db.prepare('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
  getState(key:string):string|undefined{return (this.db.prepare('SELECT value FROM app_state WHERE key=?').get(key) as {value:string}|undefined)?.value}
}
