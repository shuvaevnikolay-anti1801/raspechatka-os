import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  CartLine, CashOperation, CashOperationType, Customer, HeldReceipt, OutboxEvent,
  PaymentPart, Product, ReturnSummary, SaleDetails, SaleSummary, Shift, ShiftSummary
} from '../shared/contracts'

const emptySummary=():ShiftSummary=>({
  receipts:0,revenueMinor:0,returnsMinor:0,cashMinor:0,cardMinor:0,qrMinor:0,
  depositsMinor:0,withdrawalsMinor:0,expectedCashMinor:0
})

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
        discount_percent REAL NOT NULL DEFAULT 0, line_total_minor INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (sale_id) REFERENCES sales(id)
      );
      CREATE TABLE IF NOT EXISTS sale_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id TEXT NOT NULL, method TEXT NOT NULL,
        amount_minor INTEGER NOT NULL, transaction_id TEXT,
        FOREIGN KEY (sale_id) REFERENCES sales(id)
      );
      CREATE TABLE IF NOT EXISTS returns (
        id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL UNIQUE, sale_id TEXT NOT NULL,
        shift_id TEXT NOT NULL, total_minor INTEGER NOT NULL, fiscal_number TEXT NOT NULL,
        created_at TEXT NOT NULL, FOREIGN KEY (sale_id) REFERENCES sales(id),
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
      );
      CREATE TABLE IF NOT EXISTS return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT NOT NULL, sale_item_id INTEGER NOT NULL,
        quantity REAL NOT NULL, line_total_minor INTEGER NOT NULL,
        FOREIGN KEY (return_id) REFERENCES returns(id), FOREIGN KEY (sale_item_id) REFERENCES sale_items(id)
      );
      CREATE TABLE IF NOT EXISTS return_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT NOT NULL, method TEXT NOT NULL,
        amount_minor INTEGER NOT NULL, transaction_id TEXT,
        FOREIGN KEY (return_id) REFERENCES returns(id)
      );
      CREATE TABLE IF NOT EXISTS cash_operations (
        id TEXT PRIMARY KEY, shift_id TEXT NOT NULL, operation_type TEXT NOT NULL,
        amount_minor INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
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
    this.ensureColumn('sale_items', 'line_total_minor', 'INTEGER NOT NULL DEFAULT 0')
  }

  private ensureColumn(table:string,column:string,definition:string):void {
    const columns=this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>
    if(!columns.some((item)=>item.name===column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private seedDemoData():void {
    const insert=this.db.prepare(`INSERT OR IGNORE INTO products
      (id,name,sku,category,item_type,uom,barcode,stock,price_minor) VALUES (?,?,?,?,?,?,?,?,?)`)
    const products:Product[]=[
      {id:'print-bw-a4',name:'Печать ч/б A4',sku:'SVC-001',category:'Печать',type:'service',uom:'лист',priceMinor:2000},
      {id:'print-color-a4',name:'Печать цветная A4',sku:'SVC-002',category:'Печать',type:'service',uom:'лист',priceMinor:4000},
      {id:'scan-a4',name:'Сканирование A4',sku:'SVC-003',category:'Документы',type:'service',uom:'лист',priceMinor:5000},
      {id:'photo-docs',name:'Фото на документы',sku:'SVC-004',category:'Фото',type:'service',uom:'комплект',priceMinor:45000},
      {id:'lamination-a4',name:'Ламинирование A4',sku:'SVC-005',category:'Документы',type:'service',uom:'лист',priceMinor:8000},
      {id:'envelope-c5',name:'Конверт C5',sku:'PRD-001',category:'Товары',type:'product',uom:'шт',barcode:'460000000001',stock:24,priceMinor:2500},
      {id:'mug-print',name:'Кружка с печатью',sku:'BND-001',category:'Подарки',type:'bundle',uom:'шт',priceMinor:79000},
      {id:'binding',name:'Переплёт документа',sku:'SVC-006',category:'Документы',type:'service',uom:'шт',priceMinor:25000}
    ]
    this.db.exec('BEGIN')
    try {
      products.forEach((x)=>insert.run(x.id,x.name,x.sku,x.category,x.type,x.uom,x.barcode??null,x.stock??null,x.priceMinor))
      const customer=this.db.prepare('INSERT OR IGNORE INTO customers (id,name,phone,discount_percent) VALUES (?,?,?,?)')
      customer.run('retail','Розничный покупатель',null,0)
      customer.run('demo-client','Елена','+7 900 000-00-00',5)
      this.db.exec('COMMIT')
    } catch(error){this.db.exec('ROLLBACK');throw error}
  }

  listProducts():Product[]{return this.db.prepare(`SELECT id,name,sku,category,item_type AS type,uom,barcode,stock,
    price_minor AS priceMinor FROM products WHERE active=1 ORDER BY category,name`).all() as Product[]}
  replaceProducts(products:Product[]):void {
    const upsert=this.db.prepare(`INSERT INTO products
      (id,name,sku,category,item_type,uom,barcode,stock,price_minor,active) VALUES (?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,sku=excluded.sku,category=excluded.category,
      item_type=excluded.item_type,uom=excluded.uom,barcode=excluded.barcode,stock=excluded.stock,
      price_minor=excluded.price_minor,active=1`)
    this.db.exec('BEGIN')
    try{products.forEach((x)=>upsert.run(x.id,x.name,x.sku,x.category,x.type,x.uom,x.barcode??null,x.stock??null,x.priceMinor));this.db.exec('COMMIT')}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
  listCustomers(query=''):Customer[]{const q=`%${query}%`;return this.db.prepare(`SELECT id,name,phone,discount_percent AS discountPercent
    FROM customers WHERE active=1 AND (name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 50`).all(q,q) as Customer[]}

  currentShift():Shift|null{return (this.db.prepare(`SELECT id,opened_at AS openedAt,closed_at AS closedAt,cashier_name AS cashierName
    FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`).get() as Shift|undefined)??null}
  openShift(shift:Shift):Shift {
    const current=this.currentShift();if(current)return current
    this.db.prepare('INSERT INTO shifts (id,opened_at,cashier_name) VALUES (?,?,?)').run(shift.id,shift.openedAt,shift.cashierName)
    this.queue('shift.opened',shift,shift.openedAt);return shift
  }
  closeShift():ShiftSummary {
    const current=this.currentShift();if(!current)throw new Error('Нет открытой смены')
    const summary=this.getShiftSummary();const closedAt=new Date().toISOString()
    this.db.prepare('UPDATE shifts SET closed_at=? WHERE id=?').run(closedAt,current.id)
    this.queue('shift.closed',{...current,closedAt,summary},closedAt);return summary
  }

  getShiftSummary():ShiftSummary {
    const shift=this.currentShift();if(!shift)return emptySummary()
    const sales=this.db.prepare(`SELECT COUNT(*) receipts,COALESCE(SUM(total_minor),0) revenueMinor
      FROM sales WHERE shift_id=?`).get(shift.id) as {receipts:number;revenueMinor:number}
    const payments=this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN method='cash' THEN amount_minor ELSE 0 END),0) cashMinor,
      COALESCE(SUM(CASE WHEN method='card' THEN amount_minor ELSE 0 END),0) cardMinor,
      COALESCE(SUM(CASE WHEN method='qr' THEN amount_minor ELSE 0 END),0) qrMinor
      FROM sale_payments WHERE sale_id IN (SELECT id FROM sales WHERE shift_id=?)`).get(shift.id) as Pick<ShiftSummary,'cashMinor'|'cardMinor'|'qrMinor'>
    const refunds=this.db.prepare(`SELECT COALESCE(SUM(total_minor),0) returnsMinor,
      COALESCE(SUM(CASE WHEN method='cash' THEN amount_minor ELSE 0 END),0) cashReturns
      FROM returns LEFT JOIN return_payments ON return_payments.return_id=returns.id WHERE shift_id=?`).get(shift.id) as {returnsMinor:number;cashReturns:number}
    const cash=this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN operation_type='deposit' THEN amount_minor ELSE 0 END),0) depositsMinor,
      COALESCE(SUM(CASE WHEN operation_type='withdrawal' THEN amount_minor ELSE 0 END),0) withdrawalsMinor
      FROM cash_operations WHERE shift_id=?`).get(shift.id) as Pick<ShiftSummary,'depositsMinor'|'withdrawalsMinor'>
    return {...sales,...payments,returnsMinor:refunds.returnsMinor,...cash,
      expectedCashMinor:payments.cashMinor-refunds.cashReturns+cash.depositsMinor-cash.withdrawalsMinor}
  }

  findSaleByClientRequestId(id:string):{saleId:string;receiptNumber:string;totalMinor:number}|null {
    return (this.db.prepare('SELECT id saleId,fiscal_number receiptNumber,total_minor totalMinor FROM sales WHERE client_request_id=?').get(id) as {saleId:string;receiptNumber:string;totalMinor:number}|undefined)??null
  }

  saveSale(input:{id:string;clientRequestId:string;shiftId:string;totalMinor:number;paymentMethod:string;fiscalNumber:string;createdAt:string;customerName?:string;lines:CartLine[];payments:PaymentPart[]}):void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`INSERT INTO sales (id,client_request_id,shift_id,total_minor,payment_method,payment_transaction_id,fiscal_number,customer_name,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(input.id,input.clientRequestId,input.shiftId,input.totalMinor,input.paymentMethod,input.payments.map((x)=>x.transactionId).filter(Boolean).join(','),input.fiscalNumber,input.customerName??null,input.createdAt)
      const lineRaw=input.lines.map((line)=>Math.round(line.quantity*line.unitPriceMinor*(1-(line.discountPercent??0)/100)))
      const rawTotal=lineRaw.reduce((sum,x)=>sum+x,0)
      const insertLine=this.db.prepare('INSERT INTO sale_items (sale_id,product_id,name,quantity,unit_price_minor,discount_percent,line_total_minor) VALUES (?,?,?,?,?,?,?)')
      input.lines.forEach((line,index)=>{
        const allocated=index===input.lines.length-1?input.totalMinor-Math.round(input.totalMinor*lineRaw.slice(0,index).reduce((s,x)=>s+x,0)/(rawTotal||1)):Math.round(input.totalMinor*lineRaw[index]/(rawTotal||1))
        insertLine.run(input.id,line.productId,line.name,line.quantity,line.unitPriceMinor,line.discountPercent??0,allocated)
      })
      const pay=this.db.prepare('INSERT INTO sale_payments (sale_id,method,amount_minor,transaction_id) VALUES (?,?,?,?)')
      input.payments.forEach((x)=>pay.run(input.id,x.method,x.amountMinor,x.transactionId??null))
      this.queue('sale.completed',input,input.createdAt)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }

  listSales():SaleSummary[]{return this.db.prepare(`SELECT sales.id,fiscal_number receiptNumber,total_minor totalMinor,
    COALESCE((SELECT SUM(line_total_minor) FROM return_items JOIN returns ON returns.id=return_items.return_id WHERE returns.sale_id=sales.id),0) returnedMinor,
    payment_method paymentMethod,customer_name customerName,created_at createdAt,status
    FROM sales ORDER BY created_at DESC LIMIT 100`).all() as SaleSummary[]}

  getSale(id:string):SaleDetails {
    const sale=this.listSales().find((x)=>x.id===id);if(!sale)throw new Error('Чек не найден')
    const lines=this.db.prepare(`SELECT sale_items.id,product_id productId,name,quantity,unit_price_minor unitPriceMinor,
      discount_percent discountPercent,COALESCE((SELECT SUM(quantity) FROM return_items WHERE sale_item_id=sale_items.id),0) returnedQuantity
      FROM sale_items WHERE sale_id=? ORDER BY id`).all(id) as SaleDetails['lines']
    const payments=this.db.prepare('SELECT method,amount_minor amountMinor,transaction_id transactionId FROM sale_payments WHERE sale_id=? ORDER BY id').all(id) as PaymentPart[]
    return {...sale,lines,payments}
  }

  findReturnByClientRequestId(id:string):{returnId:string;receiptNumber:string;totalMinor:number}|null {
    return (this.db.prepare('SELECT id returnId,fiscal_number receiptNumber,total_minor totalMinor FROM returns WHERE client_request_id=?').get(id) as {returnId:string;receiptNumber:string;totalMinor:number}|undefined)??null
  }

  saveReturn(input:{id:string;clientRequestId:string;saleId:string;shiftId:string;totalMinor:number;fiscalNumber:string;createdAt:string;lines:Array<{saleItemId:number;quantity:number;lineTotalMinor:number}>;payments:PaymentPart[]}):void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT INTO returns (id,client_request_id,sale_id,shift_id,total_minor,fiscal_number,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.id,input.clientRequestId,input.saleId,input.shiftId,input.totalMinor,input.fiscalNumber,input.createdAt)
      const line=this.db.prepare('INSERT INTO return_items (return_id,sale_item_id,quantity,line_total_minor) VALUES (?,?,?,?)')
      input.lines.forEach((x)=>line.run(input.id,x.saleItemId,x.quantity,x.lineTotalMinor))
      const pay=this.db.prepare('INSERT INTO return_payments (return_id,method,amount_minor,transaction_id) VALUES (?,?,?,?)')
      input.payments.forEach((x)=>pay.run(input.id,x.method,x.amountMinor,x.transactionId??null))
      const remaining=(this.db.prepare(`SELECT COUNT(*) count FROM sale_items WHERE sale_id=? AND quantity>
        COALESCE((SELECT SUM(quantity) FROM return_items WHERE sale_item_id=sale_items.id),0)`).get(input.saleId) as {count:number}).count
      const returned=(this.db.prepare('SELECT COALESCE(SUM(total_minor),0) value FROM returns WHERE sale_id=?').get(input.saleId) as {value:number}).value
      const original=(this.db.prepare('SELECT total_minor value FROM sales WHERE id=?').get(input.saleId) as {value:number}).value
      this.db.prepare('UPDATE sales SET status=? WHERE id=?').run(!remaining||returned>=original?'returned':'partially_returned',input.saleId)
      this.queue('sale.returned',input,input.createdAt)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }

  listReturns():ReturnSummary[]{return this.db.prepare(`SELECT returns.id,returns.sale_id saleId,returns.fiscal_number receiptNumber,
    sales.fiscal_number originalReceiptNumber,returns.total_minor totalMinor,returns.created_at createdAt
    FROM returns JOIN sales ON sales.id=returns.sale_id ORDER BY returns.created_at DESC LIMIT 100`).all() as ReturnSummary[]}

  addCashOperation(type:CashOperationType,amountMinor:number,reason:string):CashOperation {
    const shift=this.currentShift();if(!shift)throw new Error('Сначала откройте смену')
    if(!Number.isInteger(amountMinor)||amountMinor<=0)throw new Error('Укажите сумму больше нуля')
    const operation={id:randomUUID(),type,amountMinor,reason:reason.trim()||'Без комментария',createdAt:new Date().toISOString()}
    this.db.prepare('INSERT INTO cash_operations (id,shift_id,operation_type,amount_minor,reason,created_at) VALUES (?,?,?,?,?,?)')
      .run(operation.id,shift.id,type,amountMinor,operation.reason,operation.createdAt)
    this.queue(type==='deposit'?'cash.deposited':'cash.withdrawn',{...operation,shiftId:shift.id},operation.createdAt)
    return operation
  }
  listCashOperations():CashOperation[]{const shift=this.currentShift();if(!shift)return[];return this.db.prepare(`SELECT id,operation_type type,
    amount_minor amountMinor,reason,created_at createdAt FROM cash_operations WHERE shift_id=? ORDER BY created_at DESC`).all(shift.id) as CashOperation[]}

  holdReceipt(input:Omit<HeldReceipt,'id'|'createdAt'>):HeldReceipt {const x={...input,id:randomUUID(),createdAt:new Date().toISOString()};this.db.prepare('INSERT INTO held_receipts (id,label,payload_json,created_at) VALUES (?,?,?,?)').run(x.id,x.label,JSON.stringify(x),x.createdAt);return x}
  listHeldReceipts():HeldReceipt[]{return (this.db.prepare('SELECT payload_json payload FROM held_receipts ORDER BY created_at DESC').all() as Array<{payload:string}>).map((x)=>JSON.parse(x.payload) as HeldReceipt)}
  deleteHeldReceipt(id:string):void{this.db.prepare('DELETE FROM held_receipts WHERE id=?').run(id)}

  private queue(eventType:string,payload:unknown,createdAt=new Date().toISOString()):void {
    this.db.prepare('INSERT INTO outbox (id,event_type,payload_json,created_at) VALUES (?,?,?,?)').run(randomUUID(),eventType,JSON.stringify(payload),createdAt)
  }
  pendingEvents(limit=100):OutboxEvent[]{return (this.db.prepare(`SELECT id,event_type eventType,payload_json payload,created_at createdAt
    FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT ?`).all(limit) as Array<{id:string;eventType:string;payload:string;createdAt:string}>)
    .map((x)=>({...x,payload:JSON.parse(x.payload)}))}
  markEventsSent(ids:string[]):void {if(!ids.length)return;const mark=this.db.prepare('UPDATE outbox SET sent_at=? WHERE id=?');const now=new Date().toISOString();this.db.exec('BEGIN');try{ids.forEach((id)=>mark.run(now,id));this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}}
  pendingSyncCount():number{return (this.db.prepare('SELECT COUNT(*) count FROM outbox WHERE sent_at IS NULL').get() as {count:number}).count}
  setState(key:string,value:string):void{this.db.prepare('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
  getState(key:string):string|undefined{return (this.db.prepare('SELECT value FROM app_state WHERE key=?').get(key) as {value:string}|undefined)?.value}
}
