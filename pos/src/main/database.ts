import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  CartLine, CashOperation, CashOperationType, Customer, HeldReceipt, OutboxEvent,
  CashCount, CashCountLine, CleanerVisitResult, PaymentPart, Product, ReturnSummary,
  SaleDetails, SaleSummary, Shift, ShiftSummary, StockWriteOffRequest, SupplyRequestInput, WorkplaceData,
  Order, CreateUnpaidOrderRequest, UpdateOrderRequest
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
        price_minor INTEGER NOT NULL CHECK(price_minor >= 0), active INTEGER NOT NULL DEFAULT 1,
        track_inventory INTEGER NOT NULL DEFAULT 0, allow_negative_stock INTEGER NOT NULL DEFAULT 0,
        minimum_sale_price_minor INTEGER NOT NULL DEFAULT 0, prevent_discounts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT,
        discount_percent REAL NOT NULL DEFAULT 0, purchase_count INTEGER NOT NULL DEFAULT 0,
        total_spent_minor INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT, cashier_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL UNIQUE, shift_id TEXT NOT NULL,
        total_minor INTEGER NOT NULL, payment_method TEXT NOT NULL,
        payment_transaction_id TEXT NOT NULL, fiscal_number TEXT NOT NULL,
        customer_id TEXT, customer_name TEXT, receipt_discount_percent REAL NOT NULL DEFAULT 0,
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
    this.ensureColumn('sales', 'status', "TEXT NOT NULL DEFAULT 'completed'")
    this.ensureColumn('customers', 'purchase_count', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('customers', 'total_spent_minor', 'INTEGER NOT NULL DEFAULT 0')
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
    try{products.forEach((x)=>upsert.run(x.id,x.name,x.sku,x.category,x.type,x.uom,x.barcode??null,x.stock??null,x.priceMinor,
      x.trackInventory?1:0,x.allowNegativeStock?1:0,x.minimumSalePriceMinor??0,x.preventDiscounts?1:0,x.storageAddress??null));this.db.exec('COMMIT')}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
  listCustomers(query=''):Customer[]{const q=`%${query}%`;return this.db.prepare(`SELECT id,name,phone,discount_percent AS discountPercent,
    purchase_count AS purchaseCount,total_spent_minor AS totalSpentMinor
    FROM customers WHERE active=1 AND (name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 50`).all(q,q) as Customer[]}
  replaceCustomers(customers:Customer[]):void {
    const upsert=this.db.prepare(`INSERT INTO customers
      (id,name,phone,discount_percent,purchase_count,total_spent_minor,active) VALUES (?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,
      discount_percent=excluded.discount_percent,purchase_count=excluded.purchase_count,
      total_spent_minor=excluded.total_spent_minor,active=1`)
    this.db.exec('BEGIN')
    try{customers.forEach((x)=>upsert.run(x.id,x.name,x.phone??null,x.discountPercent,x.purchaseCount??0,x.totalSpentMinor??0));this.db.exec('COMMIT')}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }

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
    const refunds=this.db.prepare('SELECT COALESCE(SUM(total_minor),0) returnsMinor FROM returns WHERE shift_id=?')
      .get(shift.id) as {returnsMinor:number}
    const cashReturns=this.db.prepare(`SELECT COALESCE(SUM(amount_minor),0) value FROM return_payments
      WHERE method='cash' AND return_id IN (SELECT id FROM returns WHERE shift_id=?)`).get(shift.id) as {value:number}
    const cash=this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN operation_type='deposit' THEN amount_minor ELSE 0 END),0) depositsMinor,
      COALESCE(SUM(CASE WHEN operation_type='withdrawal' THEN amount_minor ELSE 0 END),0) withdrawalsMinor
      FROM cash_operations WHERE shift_id=?`).get(shift.id) as Pick<ShiftSummary,'depositsMinor'|'withdrawalsMinor'>
    return {...sales,...payments,returnsMinor:refunds.returnsMinor,...cash,
      expectedCashMinor:payments.cashMinor-cashReturns.value+cash.depositsMinor-cash.withdrawalsMinor}
  }

  findSaleByClientRequestId(id:string):{saleId:string;receiptNumber:string;totalMinor:number}|null {
    return (this.db.prepare('SELECT id saleId,fiscal_number receiptNumber,total_minor totalMinor FROM sales WHERE client_request_id=?').get(id) as {saleId:string;receiptNumber:string;totalMinor:number}|undefined)??null
  }

  saveSale(input:{id:string;clientRequestId:string;shiftId:string;totalMinor:number;paymentMethod:string;fiscalNumber:string;createdAt:string;customerId?:string;customerName?:string;receiptDiscountPercent:number;lines:CartLine[];payments:PaymentPart[];order?:{phone:string;comment?:string;dueAt?:string}}):void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`INSERT INTO sales (id,client_request_id,shift_id,total_minor,payment_method,payment_transaction_id,fiscal_number,customer_id,customer_name,receipt_discount_percent,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.clientRequestId,input.shiftId,input.totalMinor,input.paymentMethod,input.payments.map((x)=>x.transactionId).filter(Boolean).join(','),input.fiscalNumber,input.customerId??null,input.customerName??null,input.receiptDiscountPercent,input.createdAt)
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
      if ((input as any).order) this.createOrderFromSale(input, (input as any).order)
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
    if(countType==='opening'&&totalMinor>0)this.addCashOperation('deposit',totalMinor,'Остаток наличных при открытии смены')
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
      total_minor totalMinor,paid_minor paidMinor,status,comment,created_at createdAt,due_at dueAt,
      source_sale_id sourceSaleId,fiscal_number fiscalNumber FROM orders ORDER BY created_at DESC LIMIT 200`).all() as any[])
      .map((x)=>({...x,lines:JSON.parse(x.lines),paymentStatus:x.paidMinor>=x.totalMinor?'paid':x.paidMinor>0?'partial':'unpaid'})) as Order[]
  }
  private createOrderFromSale(input:any, meta:{phone:string;comment?:string;dueAt?:string}):Order {
    const now=input.createdAt||new Date().toISOString(); const id=randomUUID()
    const orderNumber=`ORD-${now.slice(0,10).replace(/-/g,'')}-${id.slice(0,6).toUpperCase()}`
    const customer=this.listCustomers(meta.phone).find((x)=>x.phone===meta.phone)
    const order:Order={id,orderNumber,phone:meta.phone.trim(),customerName:customer?.name||input.customerName,
      lines:input.lines,totalMinor:input.totalMinor,paidMinor:input.totalMinor,paymentStatus:'paid',status:'new',
      comment:meta.comment?.trim()||undefined,createdAt:now,dueAt:meta.dueAt,sourceSaleId:input.id,fiscalNumber:input.fiscalNumber}
    this.db.prepare(`INSERT INTO orders (id,order_number,phone,customer_id,customer_name,lines_json,total_minor,paid_minor,status,comment,due_at,source_sale_id,fiscal_number,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(order.id,order.orderNumber,order.phone,customer?.id||input.customerId||null,order.customerName||null,JSON.stringify(order.lines),order.totalMinor,order.paidMinor,order.status,order.comment||null,order.dueAt||null,order.sourceSaleId||null,order.fiscalNumber||null,now,now)
    this.queue('order.created',order,now); return order
  }
  findOrderBySourceSale(saleId:string):Order|undefined{return this.listOrders().find((x)=>x.sourceSaleId===saleId)}
  createUnpaidOrder(input:CreateUnpaidOrderRequest):Order {
    if(!input.phone.trim()||input.phone.replace(/\D/g,'').length<5)throw new Error('Укажите телефон покупателя')
    if(!input.lines.length)throw new Error('Заказ пуст')
    const now=new Date().toISOString(),id=randomUUID(),orderNumber=`ORD-${now.slice(0,10).replace(/-/g,'')}-${id.slice(0,6).toUpperCase()}`
    const totalMinor=input.lines.reduce((s,x)=>s+Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent||0)/100)),0)
    if(totalMinor<=0)throw new Error('Сумма заказа должна быть больше нуля')
    const order:Order={id,orderNumber,phone:input.phone.trim(),lines:input.lines,totalMinor,paidMinor:0,paymentStatus:'unpaid',status:'new',comment:input.comment?.trim()||undefined,createdAt:now,dueAt:input.dueAt}
    this.db.prepare(`INSERT INTO orders (id,order_number,phone,lines_json,total_minor,paid_minor,status,comment,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,orderNumber,order.phone,JSON.stringify(order.lines),totalMinor,0,'new',order.comment||null,order.dueAt||null,now,now)
    this.queue('order.created',order,now);return order
  }
  updateOrder(input:UpdateOrderRequest):Order {
    const current=this.listOrders().find((x)=>x.id===input.id);if(!current)throw new Error('Заказ не найден')
    const next={...current,phone:input.phone?.trim()||current.phone,comment:input.comment===undefined?current.comment:input.comment.trim()||undefined,status:input.status||current.status,dueAt:input.dueAt===undefined?current.dueAt:input.dueAt}
    if(next.phone.replace(/\D/g,'').length<5)throw new Error('Укажите корректный телефон')
    if(!['new','in_progress','ready','issued','cancelled'].includes(next.status))throw new Error('Некорректный статус заказа')
    const updatedAt=new Date().toISOString();this.db.prepare('UPDATE orders SET phone=?,comment=?,status=?,due_at=?,updated_at=? WHERE id=?').run(next.phone,next.comment||null,next.status,next.dueAt||null,updatedAt,input.id)
    const result={...next};this.queue('order.updated',result,updatedAt);return result
  }

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
