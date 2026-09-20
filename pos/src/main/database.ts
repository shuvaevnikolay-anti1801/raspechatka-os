import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  CartLine, CashOperation, CashOperationType, Customer, HeldReceipt, OutboxEvent,
  CashCount, CashCountLine, CleanerVisitResult, DiscountBreakdown, ManualDiscount, PaymentPart, Product, RemotePaymentConfirmation, ReturnSummary,
  SaleDetails, SaleSummary, Shift, ShiftSummary, StockWriteOffRequest, SupplyRequestInput, WorkplaceData,
  Order, CreateUnpaidOrderRequest, UpdateOrderRequest
} from '../shared/contracts'
import type { PointEmployee, ReceiptMirror } from '../shared/contracts'
import { normalizeRussianPhone } from '../shared/phone'

const emptySummary=():ShiftSummary=>({
  receipts:0,revenueMinor:0,returnsMinor:0,cashMinor:0,cardMinor:0,qrMinor:0,remotePaymentMinor:0,
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

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT 'service',
        uom TEXT NOT NULL DEFAULT 'шт', barcode TEXT, stock REAL,
        price_minor INTEGER NOT NULL CHECK(price_minor >= 0), active INTEGER NOT NULL DEFAULT 1,
        track_inventory INTEGER NOT NULL DEFAULT 0, allow_negative_stock INTEGER NOT NULL DEFAULT 0,
        minimum_sale_price_minor INTEGER NOT NULL DEFAULT 0, prevent_discounts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT,
        normalized_phone TEXT NOT NULL DEFAULT '',
        discount_percent REAL NOT NULL DEFAULT 0, purchase_count INTEGER NOT NULL DEFAULT 0,
        total_spent_minor INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT, cashier_name TEXT NOT NULL,
        cashier_id TEXT NOT NULL DEFAULT '', shift_type TEXT NOT NULL DEFAULT 'Утро'
      );
      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL UNIQUE, shift_id TEXT NOT NULL,
        total_minor INTEGER NOT NULL, payment_method TEXT NOT NULL,
        payment_transaction_id TEXT NOT NULL, fiscal_number TEXT NOT NULL,
        customer_id TEXT, customer_name TEXT, receipt_discount_percent REAL NOT NULL DEFAULT 0,
        remote_payment_confirmation_json TEXT,
        status TEXT NOT NULL DEFAULT 'completed', created_at TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS cash_counts (
        id TEXT PRIMARY KEY, shift_id TEXT NOT NULL, count_type TEXT NOT NULL,
        lines_json TEXT NOT NULL, total_minor INTEGER NOT NULL, expected_minor INTEGER NOT NULL,
        difference_minor INTEGER NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, phone TEXT NOT NULL,
        customer_id TEXT, customer_name TEXT, lines_json TEXT NOT NULL,
        total_minor INTEGER NOT NULL, paid_minor INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new', comment TEXT, due_at TEXT,
        source_sale_id TEXT, fiscal_number TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS point_employees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, confirmed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cashier_credentials (
        employee_id TEXT PRIMARY KEY, pin_salt TEXT NOT NULL, pin_verifier TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipt_mirror (
        id TEXT PRIMARY KEY, server_id TEXT NOT NULL UNIQUE, external_id TEXT,
        point_id TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_customers_active_name ON customers(active,name);
      CREATE INDEX IF NOT EXISTS idx_customers_active_phone ON customers(active,normalized_phone);
      CREATE INDEX IF NOT EXISTS idx_receipt_mirror_point_created ON receipt_mirror(point_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    `)
    this.ensureColumn('products', 'item_type', "TEXT NOT NULL DEFAULT 'service'")
    this.ensureColumn('products', 'uom', "TEXT NOT NULL DEFAULT 'шт'")
    this.ensureColumn('products', 'barcode', 'TEXT')
    this.ensureColumn('products', 'stock', 'REAL')
    this.ensureColumn('products', 'track_inventory', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('products', 'allow_negative_stock', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('products', 'minimum_sale_price_minor', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('products', 'prevent_discounts', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('products', 'storage_address', 'TEXT')
    this.ensureColumn('sales', 'customer_id', 'TEXT')
    this.ensureColumn('sales', 'customer_name', 'TEXT')
    this.ensureColumn('sales', 'receipt_discount_percent', 'REAL NOT NULL DEFAULT 0')
    this.ensureColumn('sales', 'remote_payment_confirmation_json', 'TEXT')
    this.ensureColumn('sales', 'discount_breakdown_json', 'TEXT')
    this.ensureColumn('sales', 'status', "TEXT NOT NULL DEFAULT 'completed'")
    this.ensureColumn('customers', 'purchase_count', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('customers', 'total_spent_minor', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('customers', 'normalized_phone', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('orders', 'origin', "TEXT NOT NULL DEFAULT 'local'")
    this.ensureColumn('orders', 'point_id', 'TEXT')
    this.ensureColumn('orders', 'ready_at', 'TEXT')
    this.ensureColumn('orders', 'issued_at', 'TEXT')
    const legacyPhones=this.db.prepare("SELECT id,phone FROM customers WHERE normalized_phone='' AND phone IS NOT NULL").all() as Array<{id:string;phone:string}>
    const updatePhone=this.db.prepare('UPDATE customers SET normalized_phone=? WHERE id=?')
    legacyPhones.forEach((row)=>updatePhone.run(normalizeRussianPhone(row.phone),row.id))
    this.ensureColumn('sale_items', 'discount_percent', 'REAL NOT NULL DEFAULT 0')
    this.ensureColumn('sale_items', 'line_total_minor', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('shifts', 'cashier_id', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('shifts', 'shift_type', "TEXT NOT NULL DEFAULT 'Утро'")
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
      price_minor AS priceMinor,track_inventory AS trackInventory,allow_negative_stock AS allowNegativeStock,
      minimum_sale_price_minor AS minimumSalePriceMinor,prevent_discounts AS preventDiscounts,
      storage_address AS storageAddress
      FROM products WHERE active=1 ORDER BY category,name`).all().map((x:any)=>({
        ...x,trackInventory:Boolean(x.trackInventory),allowNegativeStock:Boolean(x.allowNegativeStock),
        preventDiscounts:Boolean(x.preventDiscounts)
      })) as Product[]}
  replaceProducts(products:Product[]):void {
    const upsert=this.db.prepare(`INSERT INTO products
      (id,name,sku,category,item_type,uom,barcode,stock,price_minor,active,track_inventory,allow_negative_stock,minimum_sale_price_minor,prevent_discounts,storage_address)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,sku=excluded.sku,category=excluded.category,
      item_type=excluded.item_type,uom=excluded.uom,barcode=excluded.barcode,stock=excluded.stock,
      price_minor=excluded.price_minor,active=1,track_inventory=excluded.track_inventory,
      allow_negative_stock=excluded.allow_negative_stock,minimum_sale_price_minor=excluded.minimum_sale_price_minor,
      prevent_discounts=excluded.prevent_discounts,storage_address=excluded.storage_address`)
    this.db.exec('BEGIN')
    try{this.db.exec('UPDATE products SET active=0');products.forEach((x)=>upsert.run(x.id,x.name,x.sku,x.category,x.type,x.uom,x.barcode??null,x.stock??null,x.priceMinor,
      x.trackInventory?1:0,x.allowNegativeStock?1:0,x.minimumSalePriceMinor??0,x.preventDiscounts?1:0,x.storageAddress??null));this.db.exec('COMMIT')}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
  listCustomers(query=''):Customer[]{const phone=(normalizeRussianPhone(query)||query.replace(/\D/g,'')).replace(/^\+/,'');if(phone.length<4)return [];const phoneQuery=`%${phone}%`;return this.db.prepare(`SELECT id,name,phone,discount_percent AS discountPercent
    FROM customers WHERE active=1 AND normalized_phone LIKE ? ORDER BY name LIMIT 51`).all(phoneQuery) as Customer[]}
  getCustomer(id:string):Customer|null{return (this.db.prepare(`SELECT id,name,phone,discount_percent AS discountPercent
    FROM customers WHERE id=? AND active=1 LIMIT 1`).get(id) as Customer|undefined)??null}
  replaceCustomers(customers:Customer[]):void {
    const upsert=this.db.prepare(`INSERT INTO customers
      (id,name,phone,normalized_phone,discount_percent,active) VALUES (?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,
      normalized_phone=excluded.normalized_phone,
      discount_percent=excluded.discount_percent,active=1`)
    this.db.exec('BEGIN')
    try{this.db.exec('UPDATE customers SET active=0');customers.forEach((x)=>upsert.run(x.id,x.name,x.phone,normalizeRussianPhone(x.phone),x.discountPercent));this.db.exec('COMMIT')}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }

  currentShift():Shift|null{return (this.db.prepare(`SELECT id,opened_at AS openedAt,closed_at AS closedAt,cashier_id AS cashierId,cashier_name AS cashierName,shift_type AS shiftType
    FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`).get() as Shift|undefined)??null}
  openShift(shift:Shift):Shift {
    const current=this.currentShift();if(current)return current
    const opened=new Date(shift.openedAt),dayStart=new Date(opened);dayStart.setHours(0,0,0,0);const dayEnd=new Date(dayStart);dayEnd.setDate(dayEnd.getDate()+1)
    const count=(this.db.prepare('SELECT COUNT(*) count FROM shifts WHERE opened_at>=? AND opened_at<?').get(dayStart.toISOString(),dayEnd.toISOString()) as {count:number}).count
    const persisted={...shift,shiftType:count===0?'Утро' as const:'Вечер' as const}
    this.db.prepare('INSERT INTO shifts (id,opened_at,cashier_id,cashier_name,shift_type) VALUES (?,?,?,?,?)').run(persisted.id,persisted.openedAt,persisted.cashierId??'',persisted.cashierName,persisted.shiftType)
    this.queue('shift.opened',persisted,persisted.openedAt);return persisted
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
      COALESCE(SUM(CASE WHEN method='qr' THEN amount_minor ELSE 0 END),0) qrMinor,
      COALESCE(SUM(CASE WHEN method='remote_payment' THEN amount_minor ELSE 0 END),0) remotePaymentMinor
      FROM sale_payments WHERE sale_id IN (SELECT id FROM sales WHERE shift_id=?)`).get(shift.id) as Pick<ShiftSummary,'cashMinor'|'cardMinor'|'qrMinor'|'remotePaymentMinor'>
    const refunds=this.db.prepare('SELECT COALESCE(SUM(total_minor),0) returnsMinor FROM returns WHERE shift_id=?')
      .get(shift.id) as {returnsMinor:number}
    const cashReturns=this.db.prepare(`SELECT COALESCE(SUM(amount_minor),0) value FROM return_payments
      WHERE method='cash' AND return_id IN (SELECT id FROM returns WHERE shift_id=?)`).get(shift.id) as {value:number}
    const cash=this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN operation_type='deposit' THEN amount_minor ELSE 0 END),0) depositsMinor,
      COALESCE(SUM(CASE WHEN operation_type='withdrawal' THEN amount_minor ELSE 0 END),0) withdrawalsMinor
      FROM cash_operations WHERE shift_id=?`).get(shift.id) as Pick<ShiftSummary,'depositsMinor'|'withdrawalsMinor'>
    const opening=(this.db.prepare("SELECT total_minor value FROM cash_counts WHERE shift_id=? AND count_type='opening' ORDER BY created_at LIMIT 1").get(shift.id) as {value:number}|undefined)?.value??0
    return {...sales,...payments,returnsMinor:refunds.returnsMinor,...cash,
      expectedCashMinor:opening+payments.cashMinor-cashReturns.value+cash.depositsMinor-cash.withdrawalsMinor}
  }

  findSaleByClientRequestId(id:string):{saleId:string;receiptNumber:string;totalMinor:number}|null {
    return (this.db.prepare('SELECT id saleId,fiscal_number receiptNumber,total_minor totalMinor FROM sales WHERE client_request_id=?').get(id) as {saleId:string;receiptNumber:string;totalMinor:number}|undefined)??null
  }

  saveSale(input:{id:string;clientRequestId:string;shiftId:string;totalMinor:number;paymentMethod:string;fiscalNumber:string;createdAt:string;customerId?:string;customerName?:string;receiptDiscountPercent:number;clubDiscountPercent?:number;clubDiscountMinor?:number;reviewCount?:number;reviewDiscountMinor?:number;manualDiscount?:ManualDiscount|null;manualDiscountType?:ManualDiscount['type']|null;manualDiscountValue?:number;manualDiscountMinor?:number;totalDiscountMinor?:number;discountBreakdown?:DiscountBreakdown;lines:CartLine[];payments:PaymentPart[];remotePaymentConfirmation?:RemotePaymentConfirmation;order?:{phone:string;comment?:string;dueAt?:string}}):void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`INSERT INTO sales (id,client_request_id,shift_id,total_minor,payment_method,payment_transaction_id,fiscal_number,customer_id,customer_name,receipt_discount_percent,remote_payment_confirmation_json,discount_breakdown_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.clientRequestId,input.shiftId,input.totalMinor,input.paymentMethod,input.payments.map((x)=>x.transactionId).filter(Boolean).join(','),input.fiscalNumber,input.customerId??null,input.customerName??null,input.receiptDiscountPercent,input.remotePaymentConfirmation?JSON.stringify(input.remotePaymentConfirmation):null,input.discountBreakdown?JSON.stringify(input.discountBreakdown):null,input.createdAt)
      const lineRaw=input.lines.map((line)=>Math.round(line.quantity*line.unitPriceMinor*(1-(line.discountPercent??0)/100)))
      const rawTotal=lineRaw.reduce((sum,x)=>sum+x,0)
      const insertLine=this.db.prepare('INSERT INTO sale_items (sale_id,product_id,name,quantity,unit_price_minor,discount_percent,line_total_minor) VALUES (?,?,?,?,?,?,?)')
      input.lines.forEach((line,index)=>{
        const allocated=index===input.lines.length-1?input.totalMinor-Math.round(input.totalMinor*lineRaw.slice(0,index).reduce((s,x)=>s+x,0)/(rawTotal||1)):Math.round(input.totalMinor*lineRaw[index]/(rawTotal||1))
        insertLine.run(input.id,line.productId,line.name,line.quantity,line.unitPriceMinor,line.discountPercent??0,allocated)
      })
      const pay=this.db.prepare('INSERT INTO sale_payments (sale_id,method,amount_minor,transaction_id) VALUES (?,?,?,?)')
      input.payments.forEach((x)=>pay.run(input.id,x.method,x.amountMinor,x.transactionId??null))
      const reduceStock=this.db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND track_inventory=1')
      input.lines.forEach((x)=>reduceStock.run(x.quantity,x.productId))
      this.queue('sale.completed',input,input.createdAt)
      if (input.order) this.createPaidOrderFromSaleSnapshot(input, input.order)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }

  listSales():SaleSummary[]{
    const localRows=this.db.prepare(`SELECT sales.id,fiscal_number receiptNumber,total_minor totalMinor,
      COALESCE((SELECT SUM(line_total_minor) FROM return_items JOIN returns ON returns.id=return_items.return_id WHERE returns.sale_id=sales.id),0) returnedMinor,
      payment_method paymentMethod,customer_name customerName,customers.phone customerPhone,sales.created_at createdAt,sales.status,
      sales.shift_id shiftId,shifts.cashier_id cashierId,shifts.cashier_name cashierName,
      COALESCE((SELECT GROUP_CONCAT(name,' ') FROM sale_items WHERE sale_id=sales.id),'') itemNames,
      COALESCE((SELECT GROUP_CONCAT(method,',') FROM sale_payments WHERE sale_id=sales.id),'') methods
      FROM sales
      LEFT JOIN shifts ON shifts.id=sales.shift_id
      LEFT JOIN customers ON customers.id=sales.customer_id
      ORDER BY sales.created_at DESC LIMIT 2000`).all() as Array<any>
    const local=localRows.map((row)=>{
      const paymentMethods=String(row.methods||'').split(',').filter(Boolean) as PaymentPart['method'][]
      return {
        id:String(row.id),receiptNumber:String(row.receiptNumber),totalMinor:Number(row.totalMinor),
        returnedMinor:Number(row.returnedMinor||0),paymentMethod:row.paymentMethod,
        paymentMethods,customerName:row.customerName||undefined,customerPhone:row.customerPhone||undefined,
        cashierId:row.cashierId||undefined,cashierName:row.cashierName||undefined,shiftId:row.shiftId||undefined,
        searchText:[row.receiptNumber,row.customerName,row.customerPhone,row.cashierName,row.itemNames].filter(Boolean).join(' '),
        createdAt:String(row.createdAt),status:row.status,returnable:row.status!=='returned',source:'local'
      } as SaleSummary
    })
    const localIds=new Set(local.map((row)=>row.id))
    const mirrored=(this.db.prepare('SELECT id,payload_json payload FROM receipt_mirror ORDER BY created_at DESC LIMIT 2000').all() as Array<{id:string;payload:string}>)
      .filter((row)=>!localIds.has(row.id))
      .map((row)=>{
        const payload=JSON.parse(row.payload) as ReceiptMirror
        return {
          ...payload,
          searchText:payload.searchText||[
            payload.receiptNumber,payload.customerName,payload.customerPhone,payload.cashierName,
            ...payload.lines.map((line)=>line.name)
          ].filter(Boolean).join(' '),
          paymentMethods:payload.paymentMethods||payload.payments.map((payment)=>payment.method),
          returnable:false,source:'server'
        } as SaleSummary
      })
    return [...local,...mirrored].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,2000)
  }

  getSale(id:string):SaleDetails {
    const localExists=this.db.prepare('SELECT 1 value FROM sales WHERE id=?').get(id)
    if(!localExists){
      const mirrored=this.db.prepare('SELECT payload_json payload FROM receipt_mirror WHERE id=?').get(id) as {payload:string}|undefined
      if(mirrored)return {...JSON.parse(mirrored.payload),returnable:false,source:'server'} as SaleDetails
      throw new Error('Чек не найден')
    }
    const sale=this.listSales().find((x)=>x.id===id);if(!sale)throw new Error('Чек не найден')
    const lines=this.db.prepare(`SELECT sale_items.id,product_id productId,name,quantity,unit_price_minor unitPriceMinor,
      discount_percent discountPercent,COALESCE((SELECT SUM(quantity) FROM return_items WHERE sale_item_id=sale_items.id),0) returnedQuantity
      FROM sale_items WHERE sale_id=? ORDER BY id`).all(id) as unknown as SaleDetails['lines']
    const payments=this.db.prepare('SELECT method,amount_minor amountMinor,transaction_id transactionId FROM sale_payments WHERE sale_id=? ORDER BY id').all(id) as PaymentPart[]
    const rawRemote=(this.db.prepare('SELECT remote_payment_confirmation_json value FROM sales WHERE id=?').get(id) as {value:string|null}|undefined)?.value
    return {...sale,lines,payments,remotePaymentConfirmation:rawRemote?JSON.parse(rawRemote) as RemotePaymentConfirmation:undefined}
  }

  replacePointEmployees(employees:PointEmployee[]):void {
    const insert=this.db.prepare('INSERT INTO point_employees (id,name,confirmed_at) VALUES (?,?,?)')
    const now=new Date().toISOString();this.db.exec('BEGIN')
    try{this.db.exec('DELETE FROM point_employees');employees.forEach((row)=>insert.run(row.id,row.name,now));this.db.exec('COMMIT')}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
  listPointEmployees():PointEmployee[]{return this.db.prepare('SELECT id,name FROM point_employees ORDER BY name').all() as PointEmployee[]}
  hasCashierPin(employeeId:string):boolean{return Boolean(this.db.prepare('SELECT 1 value FROM cashier_credentials WHERE employee_id=?').get(employeeId))}
  getCashierPin(employeeId:string):{salt:string;verifier:string}|undefined{return this.db.prepare('SELECT pin_salt salt,pin_verifier verifier FROM cashier_credentials WHERE employee_id=?').get(employeeId) as {salt:string;verifier:string}|undefined}
  saveCashierPin(employeeId:string,value:{salt:string;verifier:string}):void{
    this.db.prepare(`INSERT INTO cashier_credentials (employee_id,pin_salt,pin_verifier,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(employee_id) DO UPDATE SET pin_salt=excluded.pin_salt,pin_verifier=excluded.pin_verifier,updated_at=excluded.updated_at`)
      .run(employeeId,value.salt,value.verifier,new Date().toISOString())
  }

  replaceReceiptMirror(pointId:string,receipts:ReceiptMirror[],retentionDays=60):void {
    const upsert=this.db.prepare(`INSERT INTO receipt_mirror (id,server_id,external_id,point_id,created_at,payload_json,synced_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET id=excluded.id,external_id=excluded.external_id,
      point_id=excluded.point_id,created_at=excluded.created_at,payload_json=excluded.payload_json,synced_at=excluded.synced_at`)
    const now=new Date().toISOString();const cutoff=new Date(Date.now()-retentionDays*86400000).toISOString();this.db.exec('BEGIN')
    try{
      this.db.exec('DELETE FROM receipt_mirror')
      receipts.forEach((row)=>{if(row.pointId!==pointId)throw new Error('Сервер вернул чек другой точки');upsert.run(row.id,row.serverId,row.externalId??null,pointId,row.createdAt,JSON.stringify(row),now)})
      this.db.prepare('DELETE FROM receipt_mirror WHERE point_id=? AND created_at<?').run(pointId,cutoff)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }

  replaceServerOrders(pointId:string,orders:Order[],retentionDays=60):void {
    const now=new Date().toISOString();const cutoff=new Date(Date.now()-retentionDays*86400000).toISOString();this.db.exec('BEGIN')
    try{
      const previous=(this.db.prepare("SELECT id,order_number orderNumber,source_sale_id sourceSaleId FROM orders WHERE origin='server'").all() as Array<{id:string;orderNumber:string;sourceSaleId?:string}>)
      const previousByOrder=new Map(previous.map((row)=>[row.orderNumber,row.id]))
      const previousBySale=new Map(previous.filter((row)=>row.sourceSaleId).map((row)=>[row.sourceSaleId as string,row.id]))
      this.db.prepare("DELETE FROM orders WHERE origin='server'").run()
      for(const row of orders){
        const existing=this.db.prepare('SELECT id FROM orders WHERE order_number=? OR (source_sale_id IS NOT NULL AND source_sale_id=?) LIMIT 1').get(row.orderNumber,row.sourceSaleId??'__none__') as {id:string}|undefined
        const id=existing?.id||previousByOrder.get(row.orderNumber)||(row.sourceSaleId?previousBySale.get(row.sourceSaleId):undefined)||row.id
        this.db.prepare(`INSERT INTO orders (id,order_number,phone,customer_name,lines_json,total_minor,paid_minor,status,comment,due_at,ready_at,issued_at,source_sale_id,fiscal_number,created_at,updated_at,origin,point_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET order_number=excluded.order_number,phone=excluded.phone,
          customer_name=excluded.customer_name,lines_json=excluded.lines_json,total_minor=excluded.total_minor,paid_minor=excluded.paid_minor,
          status=excluded.status,comment=excluded.comment,due_at=excluded.due_at,ready_at=COALESCE(orders.ready_at,excluded.ready_at),issued_at=COALESCE(orders.issued_at,excluded.issued_at),source_sale_id=excluded.source_sale_id,
          fiscal_number=excluded.fiscal_number,updated_at=excluded.updated_at,origin='server',point_id=excluded.point_id`)
          .run(id,row.orderNumber,row.phone,row.customerName??null,JSON.stringify(row.lines),row.totalMinor,row.paidMinor,row.status,row.comment??null,row.dueAt??null,row.readyAt??null,row.issuedAt??null,row.sourceSaleId??null,row.fiscalNumber??null,row.createdAt,now,'server',pointId)
      }
      this.db.prepare("DELETE FROM orders WHERE origin='server' AND (point_id<>? OR created_at<?)").run(pointId,cutoff)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
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
      const restoreStock=this.db.prepare(`UPDATE products SET stock=stock+? WHERE id=(
        SELECT product_id FROM sale_items WHERE id=?) AND track_inventory=1`)
      input.lines.forEach((x)=>restoreStock.run(x.quantity,x.saleItemId))
      const remaining=(this.db.prepare(`SELECT COUNT(*) count FROM sale_items WHERE sale_id=? AND quantity>
        COALESCE((SELECT SUM(quantity) FROM return_items WHERE sale_item_id=sale_items.id),0)`).get(input.saleId) as {count:number}).count
      const returned=(this.db.prepare('SELECT COALESCE(SUM(total_minor),0) value FROM returns WHERE sale_id=?').get(input.saleId) as {value:number}).value
      const original=(this.db.prepare('SELECT total_minor value FROM sales WHERE id=?').get(input.saleId) as {value:number}).value
      this.db.prepare('UPDATE sales SET status=? WHERE id=?').run(!remaining||returned>=original?'returned':'partially_returned',input.saleId)
      const eventLines=input.lines.map((x)=>{
        const item=this.db.prepare('SELECT product_id productId,name,unit_price_minor unitPriceMinor FROM sale_items WHERE id=?').get(x.saleItemId) as {productId:string;name:string;unitPriceMinor:number}
        return {...x,...item}
      })
      this.queue('sale.returned',{...input,lines:eventLines},input.createdAt)
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

  getWorkplaceData():WorkplaceData {
    const raw=this.getState('workplace_data')
    return raw?JSON.parse(raw) as WorkplaceData:{schedule:[],deliveries:[],supplyRequests:[],cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},orders:[]}
  }
  setWorkplaceData(value:WorkplaceData):void{this.setState('workplace_data',JSON.stringify(value))}
  clearConfirmedPointData():void {
    this.db.exec('BEGIN')
    try {
      this.db.exec(`
        DELETE FROM point_employees;
        UPDATE customers SET active=0;
        UPDATE products SET active=0;
        DELETE FROM receipt_mirror;
        DELETE FROM orders WHERE origin='server';
        DELETE FROM app_state WHERE key IN ('bootstrap','workplace_data','point_employees_initialized');
      `)
      this.db.exec('COMMIT')
      this.setState('point_employees_initialized','1')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  reportStockWriteOff(request:StockWriteOffRequest):void {
    const product=this.listProducts().find((x)=>x.id===request.productId)
    if(!product)throw new Error('Товар не найден')
    if(!product.trackInventory)throw new Error('Для этой позиции складской учёт не ведётся')
    if(!Number.isFinite(request.quantity)||request.quantity<=0)throw new Error('Количество должно быть больше нуля')
    this.queue('stock.write_off.requested',{...request,productName:product.name,storageAddress:product.storageAddress})
  }
  createSupplyRequest(request:SupplyRequestInput):void {
    if(!request.itemName.trim())throw new Error('Укажите, что требуется точке')
    if(!Number.isFinite(request.quantity)||request.quantity<=0)throw new Error('Количество должно быть больше нуля')
    this.queue('point.supply.requested',{...request,itemName:request.itemName.trim()})
  }
  recordCleanerVisit(cashierName:string):CleanerVisitResult {
    const data=this.getWorkplaceData();const createdAt=new Date().toISOString()
    const visit={id:randomUUID(),visitDate:createdAt.slice(0,10),recordedBy:cashierName,paid:false}
    const visitsSincePayment=data.cleaner.visitsSincePayment+1
    const paymentDueMinor=visitsSincePayment>=4?200000:0
    data.cleaner={visitsSincePayment,paymentDueMinor,recentVisits:[visit,...data.cleaner.recentVisits].slice(0,12)}
    this.setWorkplaceData(data);this.queue('cleaner.visit.recorded',visit,createdAt)
    return {visit,visitsSincePayment,paymentDueMinor}
  }
  payCleaner(amountMinor:number):CashOperation {
    const data=this.getWorkplaceData()
    if(data.cleaner.paymentDueMinor<=0)throw new Error('Сейчас выплаты уборщице нет')
    if(amountMinor!==data.cleaner.paymentDueMinor)throw new Error('Сумма выплаты изменилась — обновите данные')
    const operation=this.addCashOperation('withdrawal',amountMinor,'Уборка: оплата за 4 посещения')
    data.cleaner.visitsSincePayment=Math.max(0,data.cleaner.visitsSincePayment-4)
    data.cleaner.paymentDueMinor=data.cleaner.visitsSincePayment>=4?200000:0
    data.cleaner.recentVisits=data.cleaner.recentVisits.map((x)=>({...x,paid:true}))
    this.setWorkplaceData(data);this.queue('cleaner.paid',{cashOperationId:operation.id,amountMinor})
    return operation
  }
  saveCashCount(countType:CashCount['countType'],lines:CashCountLine[]):CashCount {
    const shift=this.currentShift();if(!shift)throw new Error('Сначала откройте смену')
    const normalized=lines.filter((x)=>Number.isInteger(x.denominationMinor)&&x.denominationMinor>0&&Number.isInteger(x.quantity)&&x.quantity>=0)
    const totalMinor=normalized.reduce((sum,x)=>sum+x.denominationMinor*x.quantity,0)
    const expectedMinor=countType==='opening'?totalMinor:this.getShiftSummary().expectedCashMinor
    const count:CashCount={id:randomUUID(),countType,lines:normalized,totalMinor,expectedMinor,differenceMinor:totalMinor-expectedMinor,createdAt:new Date().toISOString()}
    this.db.prepare('INSERT INTO cash_counts (id,shift_id,count_type,lines_json,total_minor,expected_minor,difference_minor,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(count.id,shift.id,countType,JSON.stringify(normalized),totalMinor,expectedMinor,count.differenceMinor,count.createdAt)
    this.queue('cash.counted',{...count,shiftId:shift.id},count.createdAt)
    return count
  }
  getLastCashCount():CashCount|null {
    const shift=this.currentShift();if(!shift)return null
    const row=this.db.prepare(`SELECT id,count_type countType,lines_json lines,total_minor totalMinor,
      expected_minor expectedMinor,difference_minor differenceMinor,created_at createdAt
      FROM cash_counts WHERE shift_id=? ORDER BY created_at DESC LIMIT 1`).get(shift.id) as (Omit<CashCount,'lines'>&{lines:string})|undefined
    return row?{...row,lines:JSON.parse(row.lines) as CashCountLine[]}:null
  }

  listOrders():Order[] {
    return (this.db.prepare(`SELECT id,order_number orderNumber,phone,customer_name customerName,lines_json lines,
      total_minor totalMinor,paid_minor paidMinor,status,comment,created_at createdAt,due_at dueAt,ready_at readyAt,issued_at issuedAt,
      source_sale_id sourceSaleId,fiscal_number fiscalNumber FROM orders ORDER BY created_at DESC LIMIT 5000`).all() as any[])
      .map((x)=>({...x,lines:JSON.parse(x.lines),paymentStatus:x.paidMinor>=x.totalMinor?'paid':x.paidMinor>0?'partial':'unpaid'})) as Order[]
  }

  private createPaidOrderFromSaleSnapshot(
    input:{id:string;createdAt:string;lines:CartLine[];totalMinor:number;customerId?:string;customerName?:string;fiscalNumber:string},
    meta:{phone:string;comment?:string;dueAt?:string},
  ):Order {
    const phone=meta.phone.trim()
    const comment=meta.comment?.trim()||''
    const dueInput=meta.dueAt?.trim()||''
    if(phone.replace(/\D/g,'').length<5)throw new Error('Укажите корректный телефон')
    if(!comment)throw new Error('Укажите описание заказа')
    if(!dueInput||Number.isNaN(Date.parse(dueInput)))throw new Error('Укажите корректный срок готовности')
    const dueAt=new Date(dueInput).toISOString()
    const duplicate=this.db.prepare('SELECT id FROM orders WHERE source_sale_id=? LIMIT 1').get(input.id)
    if(duplicate)throw new Error('Для этого чека уже существует заказ')
    const now=input.createdAt||new Date().toISOString()
    const id=randomUUID()
    const orderNumber=`ORD-${now.slice(0,10).replace(/-/g,'')}-${id.slice(0,6).toUpperCase()}`
    const normalizedPhone=normalizeRussianPhone(phone)
    const customer=this.listCustomers(normalizedPhone.replace(/\D/g,''))
      .find((x)=>normalizeRussianPhone(x.phone)===normalizedPhone)
    const order:Order={
      id,orderNumber,phone,customerName:customer?.name||input.customerName,
      lines:input.lines,totalMinor:input.totalMinor,paidMinor:input.totalMinor,paymentStatus:'paid',status:'in_progress',
      comment,createdAt:now,dueAt,sourceSaleId:input.id,fiscalNumber:input.fiscalNumber
    }
    this.db.prepare(`INSERT INTO orders
      (id,order_number,phone,customer_id,customer_name,lines_json,total_minor,paid_minor,status,comment,due_at,source_sale_id,fiscal_number,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(order.id,order.orderNumber,order.phone,customer?.id||input.customerId||null,order.customerName||null,JSON.stringify(order.lines),
        order.totalMinor,order.paidMinor,order.status,order.comment??null,order.dueAt??null,order.sourceSaleId??null,order.fiscalNumber??null,now,now)
    this.queue('order.created',order,now)
    return order
  }

  findOrderBySourceSale(saleId:string):Order|undefined {
    return this.listOrders().find((x)=>x.sourceSaleId===saleId)
  }

  createOrderFromSale(input:{saleId:string;phone:string;comment:string;dueAt:string}):Order {
    const sale=this.getSale(input.saleId)
    if(sale.status!=='completed')throw new Error('Заказ можно создать только по завершённой оплаченной продаже без возврата')
    return this.createPaidOrderFromSaleSnapshot({
      id:sale.id,createdAt:new Date().toISOString(),lines:sale.lines,totalMinor:sale.totalMinor,
      customerName:sale.customerName,fiscalNumber:sale.receiptNumber
    },input)
  }

  createUnpaidOrder(input:CreateUnpaidOrderRequest):Order {
    if(!input.phone.trim()||input.phone.replace(/\D/g,'').length<5)throw new Error('Укажите телефон покупателя')
    if(!input.lines.length)throw new Error('Заказ пуст')
    const now=new Date().toISOString(),id=randomUUID(),orderNumber=`ORD-${now.slice(0,10).replace(/-/g,'')}-${id.slice(0,6).toUpperCase()}`
    const totalMinor=input.lines.reduce((s,x)=>s+Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent||0)/100)),0)
    if(totalMinor<=0)throw new Error('Сумма заказа должна быть больше нуля')
    const order:Order={id,orderNumber,phone:input.phone.trim(),lines:input.lines,totalMinor,paidMinor:0,paymentStatus:'unpaid',status:'new',comment:input.comment?.trim()||undefined,createdAt:now,dueAt:input.dueAt}
    this.db.prepare(`INSERT INTO orders (id,order_number,phone,lines_json,total_minor,paid_minor,status,comment,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,orderNumber,order.phone,JSON.stringify(order.lines),totalMinor,0,'new',order.comment||null,order.dueAt||null,now,now)
    this.queue('order.created',order,now)
    return order
  }

  updateOrder(input:UpdateOrderRequest):Order {
    const current=this.listOrders().find((x)=>x.id===input.id)
    if(!current)throw new Error('Заказ не найден')
    if(input.phone!==undefined&&input.phone.trim().replace(/\D/g,'').length<5)throw new Error('Укажите корректный телефон')
    if(input.comment!==undefined&&!input.comment.trim())throw new Error('Описание заказа не может быть пустым')
    if(input.dueAt!==undefined&&(!input.dueAt.trim()||Number.isNaN(Date.parse(input.dueAt))))throw new Error('Укажите корректный срок готовности')
    const normalizedDueAt=input.dueAt===undefined?current.dueAt:new Date(input.dueAt).toISOString()
    if(input.status&&input.status!==current.status){
      const allowed=(['new','in_progress'].includes(current.status)&&input.status==='ready')
        ||(current.status==='ready'&&input.status==='issued')
      if(!allowed)throw new Error('Недопустимый переход статуса заказа')
    }
    const next:Order={
      ...current,
      phone:input.phone===undefined?current.phone:input.phone.trim(),
      comment:input.comment===undefined?current.comment:input.comment.trim(),
      status:input.status||current.status,
      dueAt:normalizedDueAt,
    }
    const updatedAt=new Date().toISOString()
    const readyAt=current.readyAt||(input.status==='ready'&&current.status!=='ready'?updatedAt:undefined)
    const issuedAt=current.issuedAt||(input.status==='issued'&&current.status!=='issued'?updatedAt:undefined)
    this.db.prepare('UPDATE orders SET phone=?,comment=?,status=?,due_at=?,ready_at=?,issued_at=?,updated_at=? WHERE id=?')
      .run(next.phone,next.comment||null,next.status,next.dueAt||null,readyAt||null,issuedAt||null,updatedAt,input.id)
    const result={...next,readyAt,issuedAt}
    this.queue('order.updated',result,updatedAt)
    return result
  }

  holdReceipt(input:Omit<HeldReceipt,'id'|'createdAt'>):HeldReceipt {const x={...input,id:randomUUID(),createdAt:new Date().toISOString()};this.db.prepare('INSERT INTO held_receipts (id,label,payload_json,created_at) VALUES (?,?,?,?)').run(x.id,x.label,JSON.stringify(x),x.createdAt);return x}
  listHeldReceipts():HeldReceipt[]{return (this.db.prepare('SELECT payload_json payload FROM held_receipts ORDER BY created_at DESC').all() as Array<{payload:string}>).map((x)=>JSON.parse(x.payload) as HeldReceipt)}
  deleteHeldReceipt(id:string):void{this.db.prepare('DELETE FROM held_receipts WHERE id=?').run(id)}

  private queue(eventType:string,payload:unknown,createdAt=new Date().toISOString()):void {
    const value=payload&&typeof payload==='object'?payload as Record<string,unknown>:undefined
    const shiftId=String(value?.shiftId||value?.shift_id||'')
    const shift=(shiftId
      ?this.db.prepare('SELECT cashier_id cashierId FROM shifts WHERE id=?').get(shiftId)
      :this.db.prepare('SELECT cashier_id cashierId FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1').get()) as {cashierId:string}|undefined
    const securedPayload=value&&shift?.cashierId?{...value,cashierId:shift.cashierId}:payload
    this.db.prepare('INSERT INTO outbox (id,event_type,payload_json,created_at) VALUES (?,?,?,?)').run(randomUUID(),eventType,JSON.stringify(securedPayload),createdAt)
  }
  pendingEvents(limit=100):OutboxEvent[]{return (this.db.prepare(`SELECT id,event_type eventType,payload_json payload,created_at createdAt
    FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT ?`).all(limit) as Array<{id:string;eventType:string;payload:string;createdAt:string}>)
    .map((x)=>({...x,payload:JSON.parse(x.payload)}))}
  markEventsSent(ids:string[]):void {if(!ids.length)return;const mark=this.db.prepare('UPDATE outbox SET sent_at=? WHERE id=?');const now=new Date().toISOString();this.db.exec('BEGIN');try{ids.forEach((id)=>mark.run(now,id));this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}}
  pendingSyncCount():number{return (this.db.prepare('SELECT COUNT(*) count FROM outbox WHERE sent_at IS NULL').get() as {count:number}).count}
  setState(key:string,value:string):void{this.db.prepare('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
  getState(key:string):string|undefined{return (this.db.prepare('SELECT value FROM app_state WHERE key=?').get(key) as {value:string}|undefined)?.value}
}
