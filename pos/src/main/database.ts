import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  BankingEvidence, CartLine, CashOperation, CashOperationType, Customer, HeldReceipt, OutboxEvent,
  CashCount, CashCountLine, CashDrawerState, CleanerPayout, CleanerVisitResult, DiscountBreakdown, ManualDiscount, PaymentPart, Product, RemotePaymentConfirmation, ReturnSummary,
  SaleDetails, SaleSummary, Shift, ShiftSummary, StockReceiptRequest, StockWriteOffRequest, SupplyRequestInput, WorkplaceData, WorkScheduleMonth,
  Order, CreateUnpaidOrderRequest, UpdateOrderRequest
} from '../shared/contracts'
import type { PointEmployee, ReceiptMirror } from '../shared/contracts'
import { normalizeRussianPhone } from '../shared/phone'
import { allocateFiscalAmounts } from './providers/atol-json'

const emptySummary=():ShiftSummary=>({
  receipts:0,revenueMinor:0,returnsMinor:0,cashMinor:0,cardMinor:0,qrMinor:0,remotePaymentMinor:0,
  depositsMinor:0,withdrawalsMinor:0,expectedCashMinor:0,paymentBreakdown:[]
})

const scheduleMonthValue=(date:Date):string=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`
const adjacentScheduleMonth=(month:string,offset:number):string=>{
  const match=/^(\d{4})-(\d{2})$/.exec(month)
  if(!match)return scheduleMonthValue(new Date())
  const index=Number(match[1])*12+Number(match[2])-1+offset
  const year=Math.floor(index/12)
  const monthNumber=index-year*12+1
  return `${year}-${String(monthNumber).padStart(2,'0')}`
}
const emptyScheduleMonth=(month:string):WorkScheduleMonth=>{
  const match=/^(\d{4})-(\d{2})$/.exec(month)
  const days=match?new Date(Number(match[1]),Number(match[2]),0).getDate():0
  return {month,days,employees:[],entries:[]}
}
const normalizeScheduleMonth=(value:Partial<WorkScheduleMonth>|null|undefined,fallback:WorkScheduleMonth):WorkScheduleMonth=>{
  const month=value||{}
  return {
    ...fallback,
    ...month,
    employees:Array.isArray(month.employees)?month.employees:[],
    entries:Array.isArray(month.entries)?month.entries:[],
  }
}

export const emptyWorkplaceData=():WorkplaceData=>{
  const month=scheduleMonthValue(new Date())
  const current=emptyScheduleMonth(month)
  const next=emptyScheduleMonth(adjacentScheduleMonth(month,1))
  return {
    schedule:[],
    scheduleMonth:current,
    scheduleCurrentMonth:current,
    scheduleNextMonth:next,
    myUpcomingShifts:[],
    operationalCatalog:[],
    deliveries:[],
    supplyRequests:[],
    cleaner:{visitsSincePayment:0,paymentDueMinor:0,recentVisits:[]},
    orders:[],
  }
}
export const normalizeWorkplaceData=(value:Partial<WorkplaceData>|null|undefined):WorkplaceData=>{
  const defaults=emptyWorkplaceData()
  const incoming=value||{}
  const current=normalizeScheduleMonth(
    incoming.scheduleCurrentMonth||incoming.scheduleMonth,
    defaults.scheduleCurrentMonth,
  )
  const next=normalizeScheduleMonth(
    incoming.scheduleNextMonth,
    emptyScheduleMonth(adjacentScheduleMonth(current.month,1)),
  )
  return {
    ...defaults,
    ...incoming,
    schedule:Array.isArray(incoming.schedule)?incoming.schedule:[],
    scheduleMonth:current,
    scheduleCurrentMonth:current,
    scheduleNextMonth:next,
    myUpcomingShifts:Array.isArray(incoming.myUpcomingShifts)?incoming.myUpcomingShifts:[],
    operationalCatalog:Array.isArray(incoming.operationalCatalog)?incoming.operationalCatalog:[],
    deliveries:Array.isArray(incoming.deliveries)?incoming.deliveries.map((delivery)=>({
      ...delivery,
      items:Array.isArray(delivery.items)?delivery.items:[],
    })):[],

    supplyRequests:Array.isArray(incoming.supplyRequests)?incoming.supplyRequests:[],
    cleaner:incoming.cleaner||defaults.cleaner,
    orders:Array.isArray(incoming.orders)?incoming.orders:[],
  }
}

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
        cashier_id TEXT NOT NULL DEFAULT '', shift_type TEXT NOT NULL DEFAULT 'Утро',
        drawer_point_id TEXT, drawer_workplace_id TEXT, opening_expected_minor INTEGER,
        opening_expected_verified INTEGER NOT NULL DEFAULT 0, accounting_baseline_at TEXT
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
        amount_minor INTEGER NOT NULL, transaction_id TEXT, banking_evidence_json TEXT,
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
        amount_minor INTEGER NOT NULL, transaction_id TEXT, banking_evidence_json TEXT,
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
        expected_verified INTEGER NOT NULL DEFAULT 1,
        difference_minor INTEGER NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
      );
      CREATE TABLE IF NOT EXISTS cash_drawer_state (
        point_id TEXT NOT NULL, workplace_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
        baseline_minor INTEGER, baseline_verified INTEGER NOT NULL,
        opening_count_pending INTEGER NOT NULL, baseline_source TEXT NOT NULL,
        baseline_source_id TEXT, baseline_at TEXT, migrated_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (point_id,workplace_id),
        CHECK(schema_version = 1),
        CHECK(baseline_minor IS NULL OR baseline_minor >= 0),
        CHECK(baseline_verified IN (0,1)),
        CHECK(opening_count_pending IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS cleaning_cycles (
        point_id TEXT NOT NULL, workplace_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
        cycle_id TEXT NOT NULL, visits_count INTEGER NOT NULL DEFAULT 0,
        every_n_visits INTEGER NOT NULL, payout_amount_minor INTEGER NOT NULL,
        payout_state TEXT NOT NULL DEFAULT 'not_due', payout_id TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (point_id,workplace_id),
        CHECK(schema_version = 1), CHECK(visits_count >= 0),
        CHECK(every_n_visits >= 1), CHECK(payout_amount_minor > 0),
        CHECK(payout_state IN ('not_due','due','withdrawal_pending','paid'))
      );
      CREATE TABLE IF NOT EXISTS cleaning_visits (
        id TEXT PRIMARY KEY, point_id TEXT NOT NULL, workplace_id TEXT NOT NULL,
        cycle_id TEXT NOT NULL, local_date TEXT NOT NULL, created_at TEXT NOT NULL,
        cashier_id TEXT NOT NULL, cashier_name TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0,
        UNIQUE(point_id,local_date)
      );
      CREATE TABLE IF NOT EXISTS cleaning_payouts (
        id TEXT PRIMARY KEY, point_id TEXT NOT NULL, workplace_id TEXT NOT NULL,
        cycle_id TEXT NOT NULL UNIQUE, amount_minor INTEGER NOT NULL, every_n_visits INTEGER NOT NULL,
        visit_event_ids_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'withdrawal_pending',
        cash_operation_id TEXT UNIQUE, created_at TEXT NOT NULL, paid_at TEXT,
        CHECK(status IN ('withdrawal_pending','paid')), CHECK(amount_minor > 0), CHECK(every_n_visits >= 1)
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, phone TEXT NOT NULL, contact_method TEXT,
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
    this.ensureColumn('sale_payments', 'banking_evidence_json', 'TEXT')
    this.ensureColumn('return_payments', 'banking_evidence_json', 'TEXT')
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
    this.ensureColumn('orders', 'contact_method', 'TEXT')
    const legacyPhones=this.db.prepare("SELECT id,phone FROM customers WHERE normalized_phone='' AND phone IS NOT NULL").all() as Array<{id:string;phone:string}>
    const updatePhone=this.db.prepare('UPDATE customers SET normalized_phone=? WHERE id=?')
    legacyPhones.forEach((row)=>updatePhone.run(normalizeRussianPhone(row.phone),row.id))
    this.ensureColumn('sale_items', 'discount_percent', 'REAL NOT NULL DEFAULT 0')
    this.ensureColumn('sale_items', 'line_total_minor', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('shifts', 'cashier_id', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('shifts', 'shift_type', "TEXT NOT NULL DEFAULT 'Утро'")
    this.ensureColumn('shifts', 'drawer_point_id', 'TEXT')
    this.ensureColumn('shifts', 'drawer_workplace_id', 'TEXT')
    this.ensureColumn('shifts', 'opening_expected_minor', 'INTEGER')
    this.ensureColumn('shifts', 'opening_expected_verified', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('shifts', 'accounting_baseline_at', 'TEXT')
    this.ensureColumn('cash_operations', 'cleaning_payout_id', 'TEXT')
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_cleaning_payout ON cash_operations(cleaning_payout_id)')
    this.ensureColumn('cleaning_cycles', 'payout_id', 'TEXT')
    this.ensureColumn('cleaning_visits', 'paid', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('cash_counts', 'expected_verified', 'INTEGER NOT NULL DEFAULT 1')
    this.migrateCashDrawerV1FromBootstrap()
  }

  private ensureColumn(table:string,column:string,definition:string):void {
    const columns=this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>
    if(!columns.some((item)=>item.name===column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private cashDrawerKey(pointId:string,workplaceId:string):string {
    return `${pointId.trim()}::${workplaceId.trim()}`
  }

  private bootstrapDrawerContext():{pointId:string;workplaceId:string}|null {
    const raw=(this.db.prepare("SELECT value FROM app_state WHERE key='bootstrap'").get() as {value:string}|undefined)?.value
    if(!raw)return null
    try {
      const value=JSON.parse(raw) as {pointId?:unknown;workplaceId?:unknown}
      const pointId=typeof value.pointId==='string'?value.pointId.trim():''
      const workplaceId=typeof value.workplaceId==='string'?value.workplaceId.trim():''
      return pointId&&workplaceId?{pointId,workplaceId}:null
    } catch {
      return null
    }
  }

  private hasLegacyCashFacts():boolean {
    const row=this.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM shifts LIMIT 1)
      OR EXISTS(SELECT 1 FROM cash_counts LIMIT 1)
      OR EXISTS(SELECT 1 FROM cash_operations LIMIT 1)
      OR EXISTS(SELECT 1 FROM sales LIMIT 1)
      OR EXISTS(SELECT 1 FROM returns LIMIT 1) value`).get() as {value:number}
    return Boolean(row.value)
  }

  private legacyCashDrawerEvidence():{
    baselineMinor:number|null
    baselineVerified:boolean
    openingCountPending:boolean
    baselineSource:CashDrawerState['baselineSource']
    baselineSourceId?:string
    baselineAt?:string
  } {
    const latest=this.db.prepare(`SELECT c.id,c.count_type countType,c.total_minor totalMinor,c.created_at createdAt,
      s.closed_at closedAt
      FROM cash_counts c JOIN shifts s ON s.id=c.shift_id
      ORDER BY c.created_at DESC,c.rowid DESC LIMIT 1`).get() as
      {id:string;countType:CashCount['countType'];totalMinor:number;createdAt:string;closedAt?:string|null}|undefined
    if(!latest){
      return {
        baselineMinor:null,baselineVerified:false,openingCountPending:true,
        baselineSource:'legacy_unverified',
      }
    }
    const baselineSource:CashDrawerState['baselineSource']=
      latest.countType==='closing'?'legacy_closing_count'
        :latest.countType==='control'?'legacy_control_count':'legacy_opening_count'
    return {
      baselineMinor:latest.totalMinor,baselineVerified:true,openingCountPending:false,
      baselineSource,baselineSourceId:latest.id,baselineAt:latest.createdAt,
    }
  }

  private insertCashDrawerState(
    pointId:string,
    workplaceId:string,
    value:Pick<CashDrawerState,'baselineMinor'|'baselineVerified'|'openingCountPending'|'baselineSource'> & {
      baselineSourceId?:string
      baselineAt?:string
    },
    now=new Date().toISOString(),
  ):CashDrawerState {
    this.db.prepare(`INSERT INTO cash_drawer_state
      (point_id,workplace_id,schema_version,baseline_minor,baseline_verified,opening_count_pending,
       baseline_source,baseline_source_id,baseline_at,migrated_at,updated_at)
      VALUES (?,?,1,?,?,?,?,?,?,?,?)`)
      .run(pointId,workplaceId,value.baselineMinor,value.baselineVerified?1:0,value.openingCountPending?1:0,
        value.baselineSource,value.baselineSourceId??null,value.baselineAt??null,now,now)
    return this.readCashDrawerStateRow(pointId,workplaceId) as CashDrawerState
  }

  private readCashDrawerStateRow(pointId:string,workplaceId:string):CashDrawerState|null {
    const row=this.db.prepare(`SELECT point_id pointId,workplace_id workplaceId,schema_version schemaVersion,
      baseline_minor baselineMinor,baseline_verified baselineVerified,opening_count_pending openingCountPending,
      baseline_source baselineSource,baseline_source_id baselineSourceId,baseline_at baselineAt,
      migrated_at migratedAt,updated_at updatedAt
      FROM cash_drawer_state WHERE point_id=? AND workplace_id=?`).get(pointId,workplaceId) as
      (Omit<CashDrawerState,'baselineVerified'|'openingCountPending'> & {baselineVerified:number;openingCountPending:number})|undefined
    return row?{...row,baselineVerified:Boolean(row.baselineVerified),openingCountPending:Boolean(row.openingCountPending)}:null
  }

  private ensureCashDrawerState(pointIdInput:string,workplaceIdInput:string):CashDrawerState {
    const pointId=pointIdInput.trim(),workplaceId=workplaceIdInput.trim()
    if(!pointId||!workplaceId)throw new Error('Не задан контекст физической кассы')
    const existing=this.readCashDrawerStateRow(pointId,workplaceId)
    if(existing)return existing
    const key=this.cashDrawerKey(pointId,workplaceId)
    const owner=(this.db.prepare("SELECT value FROM app_state WHERE key='cash_drawer_legacy_owner_v1'").get() as {value:string}|undefined)?.value
    const claimsLegacy=!owner||owner===key
    if(!owner)this.db.prepare("INSERT INTO app_state (key,value) VALUES ('cash_drawer_legacy_owner_v1',?)").run(key)
    if(this.hasLegacyCashFacts()&&claimsLegacy){
      return this.insertCashDrawerState(pointId,workplaceId,this.legacyCashDrawerEvidence())
    }
    return this.insertCashDrawerState(pointId,workplaceId,{
      baselineMinor:0,baselineVerified:true,openingCountPending:false,baselineSource:'fresh_install',
    })
  }

  private migrateCashDrawerV1FromBootstrap():void {
    const context=this.bootstrapDrawerContext()
    if(!context)return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ensureCashDrawerState(context.pointId,context.workplaceId)
      this.db.exec('COMMIT')
    } catch(error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private updateCashDrawerPendingInTransaction(pointId:string,workplaceId:string,pending:boolean,now=new Date().toISOString()):void {
    this.ensureCashDrawerState(pointId,workplaceId)
    this.db.prepare(`UPDATE cash_drawer_state SET opening_count_pending=?,updated_at=?
      WHERE point_id=? AND workplace_id=?`).run(pending?1:0,now,pointId,workplaceId)
  }

  private updateCashDrawerBaselineFromStoredCountInTransaction(
    pointId:string,
    workplaceId:string,
    count:{id:string;totalMinor:number;createdAt:string},
    now=new Date().toISOString(),
  ):void {
    this.ensureCashDrawerState(pointId,workplaceId)
    this.db.prepare(`UPDATE cash_drawer_state SET baseline_minor=?,baseline_verified=1,opening_count_pending=0,
      baseline_source='cash_count',baseline_source_id=?,baseline_at=?,updated_at=?
      WHERE point_id=? AND workplace_id=?`)
      .run(count.totalMinor,count.id,count.createdAt,now,pointId,workplaceId)
  }

  private currentDrawerContext():{pointId:string;workplaceId:string}|null {
    return this.bootstrapDrawerContext()
  }

  getCashDrawerState(pointId:string,workplaceId:string):CashDrawerState {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state=this.ensureCashDrawerState(pointId,workplaceId)
      this.db.exec('COMMIT')
      return state
    } catch(error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  setCashDrawerOpeningCountPending(pointId:string,workplaceId:string,pending:boolean):CashDrawerState {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const normalizedPointId=pointId.trim(),normalizedWorkplaceId=workplaceId.trim()
      if(!normalizedPointId||!normalizedWorkplaceId)throw new Error('Не задан контекст физической кассы')
      this.updateCashDrawerPendingInTransaction(normalizedPointId,normalizedWorkplaceId,pending)
      const state=this.readCashDrawerStateRow(normalizedPointId,normalizedWorkplaceId) as CashDrawerState
      this.db.exec('COMMIT')
      return state
    } catch(error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  updateCashDrawerBaselineFromCount(pointId:string,workplaceId:string,cashCountId:string):CashDrawerState {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const normalizedPointId=pointId.trim(),normalizedWorkplaceId=workplaceId.trim()
      if(!normalizedPointId||!normalizedWorkplaceId)throw new Error('Не задан контекст физической кассы')
      const count=this.db.prepare(`SELECT id,total_minor totalMinor,created_at createdAt
        FROM cash_counts WHERE id=?`).get(cashCountId) as {id:string;totalMinor:number;createdAt:string}|undefined
      if(!count)throw new Error('Контрольный пересчёт кассы не найден')
      this.updateCashDrawerBaselineFromStoredCountInTransaction(normalizedPointId,normalizedWorkplaceId,count)
      const state=this.readCashDrawerStateRow(normalizedPointId,normalizedWorkplaceId) as CashDrawerState
      this.db.exec('COMMIT')
      return state
    } catch(error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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

  currentShift():Shift|null{
    const row=this.db.prepare(`SELECT s.id,s.opened_at openedAt,s.closed_at closedAt,s.cashier_id cashierId,s.cashier_name cashierName,
      s.shift_type shiftType,s.drawer_point_id drawerPointId,s.drawer_workplace_id drawerWorkplaceId,
      s.opening_expected_minor openingExpectedMinor,s.opening_expected_verified openingExpectedVerified,
      s.accounting_baseline_at accountingBaselineAt,
      CASE WHEN d.opening_count_pending=1 THEN 1 ELSE 0 END openingCountPending
      FROM shifts s LEFT JOIN cash_drawer_state d
        ON d.point_id=s.drawer_point_id AND d.workplace_id=s.drawer_workplace_id
      WHERE s.closed_at IS NULL ORDER BY s.opened_at DESC LIMIT 1`).get() as
      (Omit<Shift,'openingExpectedVerified'|'openingCountPending'> & {openingExpectedVerified?:number;openingCountPending?:number})|undefined
    return row?{...row,openingExpectedVerified:Boolean(row.openingExpectedVerified),openingCountPending:Boolean(row.openingCountPending)}:null
  }

  openShift(shift:Shift):Shift {
    const current=this.currentShift();if(current)return current
    const opened=new Date(shift.openedAt),dayStart=new Date(opened);dayStart.setHours(0,0,0,0);const dayEnd=new Date(dayStart);dayEnd.setDate(dayEnd.getDate()+1)
    const count=(this.db.prepare('SELECT COUNT(*) count FROM shifts WHERE opened_at>=? AND opened_at<?').get(dayStart.toISOString(),dayEnd.toISOString()) as {count:number}).count
    const shiftType=count===0?'Утро' as const:'Вечер' as const
    const context=this.currentDrawerContext()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const drawer=context?this.ensureCashDrawerState(context.pointId,context.workplaceId):null
      if(context)this.updateCashDrawerPendingInTransaction(context.pointId,context.workplaceId,true,shift.openedAt)
      this.db.prepare(`INSERT INTO shifts
        (id,opened_at,cashier_id,cashier_name,shift_type,drawer_point_id,drawer_workplace_id,opening_expected_minor,opening_expected_verified,accounting_baseline_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        shift.id,shift.openedAt,shift.cashierId??'',shift.cashierName,shiftType,
        context?.pointId??null,context?.workplaceId??null,drawer?.baselineMinor??null,drawer?.baselineVerified?1:0,
        context?shift.openedAt:null
      )
      const persisted=this.currentShift() as Shift
      this.queue('shift.opened',persisted,persisted.openedAt)
      this.db.exec('COMMIT')
      return persisted
    } catch(error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private closingCountForShift(current:Shift,summary:ShiftSummary):{id:string;totalMinor:number;expectedMinor:number;expectedVerified:number;createdAt:string}|undefined {
    const closing=this.db.prepare(`SELECT id,total_minor totalMinor,expected_minor expectedMinor,
      expected_verified expectedVerified,created_at createdAt
      FROM cash_counts WHERE shift_id=? AND count_type='closing' ORDER BY created_at DESC,rowid DESC LIMIT 1`)
      .get(current.id) as {id:string;totalMinor:number;expectedMinor:number;expectedVerified:number;createdAt:string}|undefined
    if(current.drawerPointId&&current.drawerWorkplaceId&&!closing)throw new Error('Перед закрытием рабочей смены выполните закрывающий пересчёт наличных')
    if(closing&&(closing.expectedMinor!==summary.expectedCashMinor||Boolean(closing.expectedVerified)!==Boolean(summary.expectedCashVerified))){
      throw new Error('После закрывающего пересчёта движение наличных изменилось. Выполните закрывающий пересчёт ещё раз.')
    }
    return closing
  }

  assertShiftReadyToClose():void {
    const current=this.currentShift();if(!current)throw new Error('Нет открытой смены')
    this.closingCountForShift(current,this.getShiftSummary())
  }

  closeShift():ShiftSummary {
    const current=this.currentShift();if(!current)throw new Error('Нет открытой смены')
    const summary=this.getShiftSummary()
    const closing=this.closingCountForShift(current,summary)
    const closedAt=new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if(current.drawerPointId&&current.drawerWorkplaceId&&closing){
        this.updateCashDrawerBaselineFromStoredCountInTransaction(current.drawerPointId,current.drawerWorkplaceId,closing,closedAt)
      }
      this.db.prepare('UPDATE shifts SET closed_at=? WHERE id=?').run(closedAt,current.id)
      this.queue('shift.closed',{...current,closedAt,summary},closedAt)
      this.db.exec('COMMIT')
      return summary
    } catch(error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getShiftSummary():ShiftSummary {
    const shift=this.currentShift();if(!shift)return emptySummary()
    const sales=this.db.prepare(`SELECT COUNT(*) receipts,COALESCE(SUM(total_minor),0) revenueMinor
      FROM sales WHERE shift_id=?`).get(shift.id) as {receipts:number;revenueMinor:number}
    const paymentBreakdown=this.db.prepare(`SELECT method,SUM(amount_minor) amountMinor
      FROM sale_payments WHERE sale_id IN (SELECT id FROM sales WHERE shift_id=?)
      GROUP BY method ORDER BY method`).all(shift.id) as Array<{method:string;amountMinor:number}>
    const paymentTotals=new Map(paymentBreakdown.map(({method,amountMinor})=>[method,amountMinor]))
    const payments={
      cashMinor:paymentTotals.get('cash')??0,
      cardMinor:paymentTotals.get('card')??0,
      qrMinor:paymentTotals.get('qr')??0,
      remotePaymentMinor:paymentTotals.get('remote_payment')??0,
    }
    const refunds=this.db.prepare('SELECT COALESCE(SUM(total_minor),0) returnsMinor FROM returns WHERE shift_id=?')
      .get(shift.id) as {returnsMinor:number}
    const cashReturns=this.db.prepare(`SELECT COALESCE(SUM(amount_minor),0) value FROM return_payments
      WHERE method='cash' AND return_id IN (SELECT id FROM returns WHERE shift_id=?)`).get(shift.id) as {value:number}
    const cash=this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN operation_type='deposit' THEN amount_minor ELSE 0 END),0) depositsMinor,
      COALESCE(SUM(CASE WHEN operation_type='withdrawal' THEN amount_minor ELSE 0 END),0) withdrawalsMinor
      FROM cash_operations WHERE shift_id=?`).get(shift.id) as Pick<ShiftSummary,'depositsMinor'|'withdrawalsMinor'>
    const legacyOpening=(this.db.prepare("SELECT total_minor value FROM cash_counts WHERE shift_id=? AND count_type='opening' ORDER BY created_at LIMIT 1").get(shift.id) as {value:number}|undefined)?.value
    const opening=shift.openingExpectedMinor??legacyOpening??0
    const cutoff=shift.accountingBaselineAt
    const cashSalesForExpected=cutoff
      ?Number((this.db.prepare("SELECT COALESCE(SUM(sp.amount_minor),0) value FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE s.shift_id=? AND sp.method='cash' AND s.created_at>?").get(shift.id,cutoff) as {value:number}).value)
      :payments.cashMinor
    const cashReturnsForExpected=cutoff
      ?Number((this.db.prepare("SELECT COALESCE(SUM(rp.amount_minor),0) value FROM return_payments rp JOIN returns r ON r.id=rp.return_id WHERE r.shift_id=? AND rp.method='cash' AND r.created_at>?").get(shift.id,cutoff) as {value:number}).value)
      :cashReturns.value
    const depositsForExpected=cutoff
      ?Number((this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) value FROM cash_operations WHERE shift_id=? AND operation_type='deposit' AND created_at>?").get(shift.id,cutoff) as {value:number}).value)
      :cash.depositsMinor
    const withdrawalsForExpected=cutoff
      ?Number((this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) value FROM cash_operations WHERE shift_id=? AND operation_type='withdrawal' AND created_at>?").get(shift.id,cutoff) as {value:number}).value)
      :cash.withdrawalsMinor
    const expectedCashVerified=shift.drawerPointId?Boolean(shift.openingExpectedVerified):true
    return {...sales,...payments,paymentBreakdown,returnsMinor:refunds.returnsMinor,...cash,
      expectedCashMinor:opening+cashSalesForExpected-cashReturnsForExpected+depositsForExpected-withdrawalsForExpected,
      expectedCashVerified,openingCountPending:Boolean(shift.openingCountPending)}
  }

  findSaleByClientRequestId(id:string):{saleId:string;receiptNumber:string;totalMinor:number}|null {
    return (this.db.prepare('SELECT id saleId,fiscal_number receiptNumber,total_minor totalMinor FROM sales WHERE client_request_id=?').get(id) as {saleId:string;receiptNumber:string;totalMinor:number}|undefined)??null
  }

  saveSale(input:{id:string;clientRequestId:string;shiftId:string;totalMinor:number;paymentMethod:string;fiscalNumber:string;createdAt:string;customerId?:string;customerName?:string;receiptDiscountPercent:number;clubDiscountPercent?:number;clubDiscountMinor?:number;reviewCount?:number;reviewDiscountMinor?:number;manualDiscount?:ManualDiscount|null;manualDiscountType?:ManualDiscount['type']|null;manualDiscountValue?:number;manualDiscountMinor?:number;totalDiscountMinor?:number;discountBreakdown?:DiscountBreakdown;lines:CartLine[];payments:PaymentPart[];remotePaymentConfirmation?:RemotePaymentConfirmation;order?:{phone:string;contactMethod?:string;comment?:string;dueAt?:string}}):void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`INSERT INTO sales (id,client_request_id,shift_id,total_minor,payment_method,payment_transaction_id,fiscal_number,customer_id,customer_name,receipt_discount_percent,remote_payment_confirmation_json,discount_breakdown_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.clientRequestId,input.shiftId,input.totalMinor,input.paymentMethod,input.payments.map((x)=>x.transactionId).filter(Boolean).join(','),input.fiscalNumber,input.customerId??null,input.customerName??null,input.receiptDiscountPercent,input.remotePaymentConfirmation?JSON.stringify(input.remotePaymentConfirmation):null,input.discountBreakdown?JSON.stringify(input.discountBreakdown):null,input.createdAt)
      const allocated=allocateFiscalAmounts(input.lines,input.totalMinor)
      if(input.payments.reduce((sum,payment)=>sum+payment.amountMinor,0)!==input.totalMinor)
        throw new Error('Сумма оплат не совпадает с сохранённым итогом чека')
      const insertLine=this.db.prepare('INSERT INTO sale_items (sale_id,product_id,name,quantity,unit_price_minor,discount_percent,line_total_minor) VALUES (?,?,?,?,?,?,?)')
      input.lines.forEach((line,index)=>{
        insertLine.run(input.id,line.productId,line.name,line.quantity,line.unitPriceMinor,line.discountPercent??0,allocated[index])
      })
      const pay=this.db.prepare('INSERT INTO sale_payments (sale_id,method,amount_minor,transaction_id,banking_evidence_json) VALUES (?,?,?,?,?)')
      input.payments.forEach((x)=>pay.run(input.id,x.method,x.amountMinor,x.transactionId??null,
        x.bankingEvidence?JSON.stringify(x.bankingEvidence):null))
      const reduceStock=this.db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND track_inventory=1')
      input.lines.forEach((x)=>reduceStock.run(x.quantity,x.productId))
      this.queue('sale.completed',{...input,lines:input.lines.map((line,index)=>({...line,lineTotalMinor:allocated[index]}))},input.createdAt)
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
      discount_percent discountPercent,line_total_minor lineTotalMinor,
      COALESCE((SELECT SUM(line_total_minor) FROM return_items WHERE sale_item_id=sale_items.id),0) returnedLineMinor,
      COALESCE((SELECT SUM(quantity) FROM return_items WHERE sale_item_id=sale_items.id),0) returnedQuantity
      FROM sale_items WHERE sale_id=? ORDER BY id`).all(id) as unknown as SaleDetails['lines']
    const payments=(this.db.prepare(`SELECT method,amount_minor amountMinor,transaction_id transactionId,
      banking_evidence_json bankingEvidenceJson FROM sale_payments WHERE sale_id=? ORDER BY id`).all(id) as unknown as
      Array<PaymentPart&{bankingEvidenceJson?:string|null}>).map(({bankingEvidenceJson,...payment})=>({
        ...payment,
        transactionId:payment.transactionId||undefined,
        bankingEvidence:this.parseBankingEvidence(bankingEvidenceJson)
      }))
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
        this.db.prepare(`INSERT INTO orders (id,order_number,phone,contact_method,customer_name,lines_json,total_minor,paid_minor,status,comment,due_at,ready_at,issued_at,source_sale_id,fiscal_number,created_at,updated_at,origin,point_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET order_number=excluded.order_number,phone=excluded.phone,
          contact_method=excluded.contact_method,customer_name=excluded.customer_name,lines_json=excluded.lines_json,total_minor=excluded.total_minor,paid_minor=excluded.paid_minor,
          status=excluded.status,comment=excluded.comment,due_at=excluded.due_at,ready_at=COALESCE(orders.ready_at,excluded.ready_at),issued_at=COALESCE(orders.issued_at,excluded.issued_at),source_sale_id=excluded.source_sale_id,
          fiscal_number=excluded.fiscal_number,updated_at=excluded.updated_at,origin='server',point_id=excluded.point_id`)
          .run(id,row.orderNumber,row.phone,row.contactMethod??null,row.customerName??null,JSON.stringify(row.lines),row.totalMinor,row.paidMinor,row.status,row.comment??null,row.dueAt??null,row.readyAt??null,row.issuedAt??null,row.sourceSaleId??null,row.fiscalNumber??null,row.createdAt,now,'server',pointId)
      }
      this.db.prepare("DELETE FROM orders WHERE origin='server' AND (point_id<>? OR created_at<?)").run(pointId,cutoff)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }

  getReturnedPaymentMinor(saleId:string,method:PaymentPart['method']):number {
    return Number((this.db.prepare(`SELECT COALESCE(SUM(return_payments.amount_minor),0) value
      FROM return_payments JOIN returns ON returns.id=return_payments.return_id
      WHERE returns.sale_id=? AND return_payments.method=?`).get(saleId,method) as {value:number}).value)
  }

  findReturnByClientRequestId(id:string):{returnId:string;receiptNumber:string;totalMinor:number}|null {
    return (this.db.prepare('SELECT id returnId,fiscal_number receiptNumber,total_minor totalMinor FROM returns WHERE client_request_id=?').get(id) as {returnId:string;receiptNumber:string;totalMinor:number}|undefined)??null
  }

  saveReturn(input:{id:string;clientRequestId:string;saleId:string;shiftId:string;totalMinor:number;fiscalNumber:string;createdAt:string;lines:Array<{saleItemId:number;quantity:number;lineTotalMinor:number}>;payments:PaymentPart[]}):void {
    this.db.exec('BEGIN')
    try {
      const original=this.getSale(input.saleId)
      const refunded=this.db.prepare('SELECT COALESCE(SUM(total_minor),0) amount FROM returns WHERE sale_id=?').get(input.saleId) as {amount:number}
      if(!Number.isSafeInteger(input.totalMinor)||input.totalMinor<=0||
        input.lines.reduce((sum,line)=>sum+line.lineTotalMinor,0)!==input.totalMinor||
        input.payments.reduce((sum,payment)=>sum+payment.amountMinor,0)!==input.totalMinor||
        input.totalMinor>original.totalMinor-refunded.amount||
        input.totalMinor>original.payments.reduce((sum,payment)=>sum+payment.amountMinor,0)-refunded.amount)
        throw new Error('Возврат превышает сохранённый остаток исходного чека')
      this.db.prepare('INSERT INTO returns (id,client_request_id,sale_id,shift_id,total_minor,fiscal_number,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.id,input.clientRequestId,input.saleId,input.shiftId,input.totalMinor,input.fiscalNumber,input.createdAt)
      const line=this.db.prepare('INSERT INTO return_items (return_id,sale_item_id,quantity,line_total_minor) VALUES (?,?,?,?)')
      input.lines.forEach((x)=>line.run(input.id,x.saleItemId,x.quantity,x.lineTotalMinor))
      const pay=this.db.prepare('INSERT INTO return_payments (return_id,method,amount_minor,transaction_id,banking_evidence_json) VALUES (?,?,?,?,?)')
      input.payments.forEach((x)=>pay.run(input.id,x.method,x.amountMinor,x.transactionId??null,
        x.bankingEvidence?JSON.stringify(x.bankingEvidence):null))
      const restoreStock=this.db.prepare(`UPDATE products SET stock=stock+? WHERE id=(
        SELECT product_id FROM sale_items WHERE id=?) AND track_inventory=1`)
      input.lines.forEach((x)=>restoreStock.run(x.quantity,x.saleItemId))
      const remaining=(this.db.prepare(`SELECT COUNT(*) count FROM sale_items WHERE sale_id=? AND quantity>
        COALESCE((SELECT SUM(quantity) FROM return_items WHERE sale_item_id=sale_items.id),0)`).get(input.saleId) as {count:number}).count
      const returned=(this.db.prepare('SELECT COALESCE(SUM(total_minor),0) value FROM returns WHERE sale_id=?').get(input.saleId) as {value:number}).value
      const persistedTotal=(this.db.prepare('SELECT total_minor value FROM sales WHERE id=?').get(input.saleId) as {value:number}).value
      this.db.prepare('UPDATE sales SET status=? WHERE id=?').run(!remaining||returned>=persistedTotal?'returned':'partially_returned',input.saleId)
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

  addCashOperation(type:CashOperationType,amountMinor:number,reason:string,cleaningPayoutId?:string):CashOperation {
    if(!Number.isSafeInteger(amountMinor)||amountMinor<=0)throw new Error('Укажите сумму больше нуля')
    this.db.exec('BEGIN IMMEDIATE')
    let operation!:CashOperation
    try {
      const payout=cleaningPayoutId?this.readCleaningPayout(cleaningPayoutId):null
      if(cleaningPayoutId){
        if(!payout||type!=='withdrawal'||payout.amountMinor!==amountMinor)
          throw new Error('Выплата уборки не соответствует подготовленному изъятию')
        const context=this.cleaningContext()
        if(payout.pointId!==context.pointId||payout.workplaceId!==context.workplaceId)
          throw new Error('Выплата относится к другой точке или кассе')
        const prior=this.db.prepare(`SELECT id,operation_type type,amount_minor amountMinor,
          reason,created_at createdAt,cleaning_payout_id cleaningPayoutId
          FROM cash_operations WHERE cleaning_payout_id=?`).get(cleaningPayoutId) as CashOperation|undefined
        if(prior){
          operation=prior
          this.db.exec('COMMIT')
          this.reconcileCleaningPayout(cleaningPayoutId)
          return operation
        }
        if(payout.status!=='withdrawal_pending')throw new Error('Выплата уже завершена без подтверждённого изъятия')
      }
      const shift=this.currentShift()
      if(!shift)throw new Error('Сначала откройте смену')
      if(cleaningPayoutId){
        const context=this.cleaningContext()
        if(shift.drawerPointId!==context.pointId||shift.drawerWorkplaceId!==context.workplaceId)
          throw new Error('Смена относится к другой точке или кассе')
        const summary=this.getShiftSummary()
        if(summary.expectedCashVerified===false||summary.openingCountPending)
          throw new Error('Перед выплатой подтвердите остаток кассы пересчётом')
        if(summary.expectedCashMinor<amountMinor)throw new Error('Недостаточно наличных для выплаты уборки')
      }
      const createdAt=new Date().toISOString()
      operation={
        id:randomUUID(),type,amountMinor,
        reason:cleaningPayoutId?`Уборка: оплата за ${payout!.everyNVisits} посещений`:reason.trim()||'Без комментария',
        createdAt,...(cleaningPayoutId?{cleaningPayoutId}:{})
      }
      this.db.prepare(`INSERT INTO cash_operations
        (id,shift_id,operation_type,amount_minor,reason,created_at,cleaning_payout_id)
        VALUES (?,?,?,?,?,?,?)`).run(
          operation.id,shift.id,type,amountMinor,operation.reason,createdAt,cleaningPayoutId??null
        )
      const payload=cleaningPayoutId?{
        ...operation,shiftId:shift.id,cleaningCycleId:payout!.cycleId,
        cleaningVisitEventIds:payout!.visitEventIds,everyNVisits:payout!.everyNVisits,
        payoutAmountMinor:payout!.amountMinor,withdrawalPurpose:'Expense'
      }:{...operation,shiftId:shift.id}
      this.queue(type==='deposit'?'cash.deposited':'cash.withdrawn',payload,createdAt,shift.cashierId||undefined,
        cleaningPayoutId?operation.id:undefined)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
    if(cleaningPayoutId)this.reconcileCleaningPayout(cleaningPayoutId)
    return operation
  }
  listCashOperations():CashOperation[]{const shift=this.currentShift();if(!shift)return[];return this.db.prepare(`SELECT id,operation_type type,
    amount_minor amountMinor,reason,created_at createdAt FROM cash_operations WHERE shift_id=? ORDER BY created_at DESC`).all(shift.id) as CashOperation[]}

  getWorkplaceData():WorkplaceData {
    const raw=this.getState('workplace_data')
    let data:WorkplaceData
    try { data=normalizeWorkplaceData(raw?JSON.parse(raw) as Partial<WorkplaceData>:null) }
    catch { data=emptyWorkplaceData() }
    try {
      const context=this.cleaningContext()
      this.reconcilePendingCleaner(context)
      const local=this.localCleanerStatus(context)
      if(local)data.cleaner=local
    } catch { /* A disconnected or older bootstrap has no point context yet. */ }
    return data
  }
  setWorkplaceData(value:Partial<WorkplaceData>):void{this.setState('workplace_data',JSON.stringify(normalizeWorkplaceData(value)))}
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
  reportStockWriteOff(request:StockWriteOffRequest,cashierId:string):void {
    const product=this.getWorkplaceData().operationalCatalog.find((x)=>x.id===request.productId)
    if(!product)throw new Error('Товар не найден в оперативном каталоге')
    if(!product.trackInventory||!['Product','Variant'].includes(product.itemType))throw new Error('Для этой позиции складское списание недоступно')
    if(!Number.isFinite(request.quantity)||request.quantity<=0)throw new Error('Количество должно быть больше нуля')
    if(!['Брак','Внутренние нужды','Обучение'].includes(String(request.reason||'')))throw new Error('Недопустимая причина списания')
    const comment=String(request.comment||'').trim()
    if(!comment)throw new Error('Комментарий обязателен')
    this.queue('stock.write_off.requested',{
      cashierId,
      productId:request.productId,
      quantity:request.quantity,
      reason:request.reason,
      comment,
    },undefined,cashierId)
  }
  createSupplyRequest(request:SupplyRequestInput,cashierId:string):void {
    const catalog=this.getWorkplaceData().operationalCatalog
    const product=request.productId?catalog.find((x)=>x.id===request.productId):undefined
    if(request.productId&&!product)throw new Error('Товар не найден в оперативном каталоге')
    const itemName=(product?.name||request.itemName||'').trim()
    if(!itemName)throw new Error('Укажите, что требуется точке')
    const comment=String(request.comment||'').trim()
    if(!comment)throw new Error('Комментарий обязателен')
    this.queue('point.supply.requested',{
      cashierId,
      productId:product?.id,
      itemName,
      comment,
    },undefined,cashierId)
  }
  createStockReceipt(request:StockReceiptRequest,cashierId:string):void {
    if(!request.purchaseOrderId.trim())throw new Error('Не указан заказ поставщику')
    if(!Array.isArray(request.lines)||!request.lines.length)throw new Error('В приёмке нет товаров')
    const data=this.getWorkplaceData()
    const delivery=data.deliveries.find((x)=>x.id===request.purchaseOrderId)
    if(!delivery)throw new Error('Заказ поставщику не найден среди открытых поставок')
    const available=new Map(delivery.items.map((x)=>[x.purchaseOrderItemId,x.remainingQuantity]))
    const seen=new Set<string>()
    const lines=request.lines.map((line)=>{
      const rowId=line.purchaseOrderItemId.trim()
      if(!rowId||seen.has(rowId))throw new Error('Строки приёмки должны быть уникальны')
      seen.add(rowId)
      const remaining=available.get(rowId)
      if(remaining===undefined)throw new Error('Строка не относится к открытому заказу')
      if(!Number.isFinite(line.quantity)||line.quantity<=0||line.quantity>remaining+0.000001)throw new Error('Некорректное количество приёмки')
      return {purchaseOrderItemId:rowId,quantity:line.quantity}
    })
    this.queue('stock.receipt.requested',{cashierId,purchaseOrderId:request.purchaseOrderId,lines},undefined,cashierId)

  }
  private cleaningContext():{pointId:string;workplaceId:string;timezone:string;everyNVisits:number;payoutAmountMinor:number} {
    const raw=this.getState('bootstrap')
    if(!raw)throw new Error('Сначала настройте точку и кассу')
    let bootstrap:Record<string,unknown>
    try { bootstrap=JSON.parse(raw) as Record<string,unknown> } catch { throw new Error('Настройки точки повреждены') }
    const pointId=String(bootstrap.pointId||'').trim(),workplaceId=String(bootstrap.workplaceId||'').trim()
    if(!pointId||!workplaceId)throw new Error('Не задана точка или касса')
    const cleaning=bootstrap.cleaning as {everyNVisits?:unknown;payoutAmountMinor?:unknown}|undefined
    const everyNVisits=cleaning?.everyNVisits
    const payoutAmountMinor=cleaning?.payoutAmountMinor
    return {
      pointId,workplaceId,
      timezone:typeof bootstrap.pointTimezone==='string'?bootstrap.pointTimezone:'Europe/Moscow',
      everyNVisits:typeof everyNVisits==='number'&&Number.isSafeInteger(everyNVisits)&&everyNVisits>=1?everyNVisits:4,
      payoutAmountMinor:typeof payoutAmountMinor==='number'&&Number.isSafeInteger(payoutAmountMinor)&&payoutAmountMinor>0?payoutAmountMinor:200000,
    }
  }

  private pointLocalDate(instant:Date,timezone:string):string {
    let parts:Intl.DateTimeFormatPart[]
    try {
      parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(instant)
    } catch {
      parts=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(instant)
    }
    const field=(name:string)=>parts.find((part)=>part.type===name)?.value||''
    return `${field('year')}-${field('month')}-${field('day')}`
  }

  private ensureCleaningCycle(context:ReturnType<PosDatabase['cleaningContext']>):void {
    const existing=this.db.prepare('SELECT visits_count visitsCount,payout_state payoutState FROM cleaning_cycles WHERE point_id=? AND workplace_id=?')
      .get(context.pointId,context.workplaceId) as {visitsCount:number;payoutState:string}|undefined
    if(existing){
      if(existing.visitsCount===0&&existing.payoutState==='not_due')
        this.db.prepare('UPDATE cleaning_cycles SET every_n_visits=?,payout_amount_minor=? WHERE point_id=? AND workplace_id=?')
          .run(context.everyNVisits,context.payoutAmountMinor,context.pointId,context.workplaceId)
      return
    }
    const key=`${context.pointId}::${context.workplaceId}`
    const owner=this.getState('cleaning_legacy_owner_v1')
    const legacy=!owner?this.getWorkplaceData().cleaner:null
    const legacyCount=Number(legacy?.visitsSincePayment)
    const count=Math.min(context.everyNVisits,Math.max(0,Number.isSafeInteger(legacyCount)?legacyCount:0))
    const due=count>=context.everyNVisits||Number(legacy?.paymentDueMinor)>0
    const cycleId=randomUUID(),now=new Date().toISOString()
    this.db.prepare(`INSERT INTO cleaning_cycles
      (point_id,workplace_id,schema_version,cycle_id,visits_count,every_n_visits,payout_amount_minor,payout_state,updated_at)
      VALUES (?,?,1,?,?,?,?,?,?)`)
      .run(context.pointId,context.workplaceId,cycleId,due?context.everyNVisits:count,
        context.everyNVisits,context.payoutAmountMinor,due?'due':'not_due',now)
    if(!owner){
      this.setState('cleaning_legacy_owner_v1',key)
      for(const visit of Array.isArray(legacy?.recentVisits)?legacy.recentVisits:[]){
        if(!visit.id)continue
        const queued=this.db.prepare(`SELECT created_at createdAt FROM outbox
          WHERE event_type='cleaner.visit.recorded' AND json_extract(payload_json,'$.id')=?
          ORDER BY created_at LIMIT 1`).get(visit.id) as {createdAt:string}|undefined
        const localDate=queued?this.pointLocalDate(new Date(queued.createdAt),context.timezone):visit.visitDate
        if(!/^\d{4}-\d{2}-\d{2}$/.test(localDate))continue
        this.db.prepare(`INSERT OR IGNORE INTO cleaning_visits
          (id,point_id,workplace_id,cycle_id,local_date,created_at,cashier_id,cashier_name)
          VALUES (?,?,?,?,?,?,?,?)`).run(
            visit.id||randomUUID(),context.pointId,context.workplaceId,cycleId,localDate,now,'',visit.recordedBy||''
          )
      }
    }
  }

  private localCleanerStatus(context:ReturnType<PosDatabase['cleaningContext']>):WorkplaceData['cleaner']|null {
    const cycle=this.db.prepare(`SELECT cycle_id cycleId,schema_version schemaVersion,
      visits_count visitsSincePayment,every_n_visits everyNVisits,payout_amount_minor payoutAmountMinor,
      payout_state payoutState,payout_id payoutId FROM cleaning_cycles WHERE point_id=? AND workplace_id=?`)
      .get(context.pointId,context.workplaceId) as
      Pick<WorkplaceData['cleaner'],'cycleId'|'schemaVersion'|'visitsSincePayment'|'everyNVisits'|'payoutAmountMinor'|'payoutState'|'payoutId'>|undefined
    if(!cycle)return null
    const visits=this.db.prepare(`SELECT id,local_date visitDate,cashier_name recordedBy,paid
      FROM cleaning_visits WHERE point_id=? AND workplace_id=? ORDER BY local_date DESC LIMIT 12`)
      .all(context.pointId,context.workplaceId) as Array<{id:string;visitDate:string;recordedBy:string;paid:number}>
    return {...cycle,paymentDueMinor:cycle.payoutState==='due'||cycle.payoutState==='withdrawal_pending'
      ?cycle.payoutAmountMinor||0:0,recentVisits:visits.map((visit)=>({...visit,paid:Boolean(visit.paid)}))}
  }

  recordCleanerVisit(_cashierName:string):CleanerVisitResult {
    const context=this.cleaningContext()
    this.reconcilePendingCleaner(context)
    const shift=this.currentShift()
    if(!shift?.cashierId)throw new Error('Сначала откройте смену сотрудника')
    if(shift.drawerPointId!==context.pointId||shift.drawerWorkplaceId!==context.workplaceId)
      throw new Error('Смена относится к другой точке или кассе')
    const createdAt=new Date().toISOString(),visitDate=this.pointLocalDate(new Date(createdAt),context.timezone)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ensureCleaningCycle(context)
      const existing=this.db.prepare(`SELECT id,local_date visitDate,cashier_name recordedBy,
        workplace_id workplaceId FROM cleaning_visits WHERE point_id=? AND local_date=?`)
        .get(context.pointId,visitDate) as {id:string;visitDate:string;recordedBy:string;workplaceId:string}|undefined
      if(existing){
        const status=this.localCleanerStatus({...context,workplaceId:existing.workplaceId})!
        this.db.exec('COMMIT')
        return {visit:{id:existing.id,visitDate,recordedBy:existing.recordedBy,paid:false},
          visitsSincePayment:status.visitsSincePayment,paymentDueMinor:status.paymentDueMinor}
      }
      const status=this.localCleanerStatus(context)!
      if(status.payoutState!=='not_due'||status.visitsSincePayment>=status.everyNVisits!)
        throw new Error('Сначала завершите выплату за текущий цикл уборки')
      const visit={id:randomUUID(),visitDate,recordedBy:shift.cashierName,paid:false}
      this.db.prepare(`INSERT INTO cleaning_visits
        (id,point_id,workplace_id,cycle_id,local_date,created_at,cashier_id,cashier_name)
        VALUES (@id,@pointId,@workplaceId,@cycleId,@visitDate,@createdAt,@cashierId,@cashierName)`).run({
          id:visit.id,pointId:context.pointId,workplaceId:context.workplaceId,cycleId:status.cycleId!,
          visitDate,createdAt,cashierId:shift.cashierId,cashierName:shift.cashierName
        })
      const visitsSincePayment=status.visitsSincePayment+1
      const due=visitsSincePayment>=status.everyNVisits!
      this.db.prepare(`UPDATE cleaning_cycles SET visits_count=?,payout_state=?,updated_at=?
        WHERE point_id=? AND workplace_id=?`).run(
          visitsSincePayment,due?'due':'not_due',createdAt,context.pointId,context.workplaceId
        )
      this.queue('cleaner.visit.recorded',
        {id:visit.id,visitDate,recordedBy:shift.cashierName,shiftId:shift.id,cleaningCycleId:status.cycleId},
        createdAt,shift.cashierId,visit.id)
      this.db.exec('COMMIT')
      return {visit,visitsSincePayment,paymentDueMinor:due?status.payoutAmountMinor!:0}
    } catch(error) { this.db.exec('ROLLBACK');throw error }
  }
  private readCleaningPayout(id:string):(CleanerPayout & {pointId:string;workplaceId:string})|null {
    const row=this.db.prepare(`SELECT id,point_id pointId,workplace_id workplaceId,
      cycle_id cycleId,amount_minor amountMinor,every_n_visits everyNVisits,
      visit_event_ids_json visitEventIdsJson,status,cash_operation_id cashOperationId
      FROM cleaning_payouts WHERE id=?`).get(id) as
      (Omit<CleanerPayout,'visitEventIds'> & {pointId:string;workplaceId:string;visitEventIdsJson:string})|undefined
    return row?{...row,visitEventIds:JSON.parse(row.visitEventIdsJson) as string[]}:null
  }

  private reconcilePendingCleaner(context:ReturnType<PosDatabase['cleaningContext']>):void {
    const cycle=this.localCleanerStatus(context)
    if(cycle?.payoutState==='withdrawal_pending'&&cycle.payoutId)
      this.reconcileCleaningPayout(cycle.payoutId)
  }

  private reconcileCleaningPayout(id:string):void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const payout=this.readCleaningPayout(id)
      if(!payout)throw new Error('Ссылка выплаты уборки не найдена')
      const operation=this.db.prepare(`SELECT id,shift_id shiftId,operation_type type,
        amount_minor amountMinor FROM cash_operations WHERE cleaning_payout_id=?`).get(id) as
        {id:string;shiftId:string;type:CashOperationType;amountMinor:number}|undefined
      if(!operation){
        this.db.exec('COMMIT')
        return
      }
      if(operation.type!=='withdrawal'||operation.amountMinor!==payout.amountMinor)
        throw new Error('Изъятие не соответствует сохранённой выплате уборки')
      if(payout.cashOperationId&&payout.cashOperationId!==operation.id)
        throw new Error('Выплата уже связана с другим изъятием')
      if(payout.status!=='paid'){
        const now=new Date().toISOString()
        this.db.prepare(`UPDATE cleaning_payouts SET status='paid',cash_operation_id=?,paid_at=? WHERE id=?`)
          .run(operation.id,now,id)
        this.db.prepare('UPDATE cleaning_visits SET paid=1 WHERE cycle_id=? AND point_id=? AND workplace_id=?')
          .run(payout.cycleId,payout.pointId,payout.workplaceId)
        this.db.prepare(`UPDATE cleaning_cycles SET cycle_id=?,visits_count=0,payout_state='not_due',
          payout_id=NULL,updated_at=? WHERE point_id=? AND workplace_id=? AND cycle_id=? AND payout_id=?`)
          .run(randomUUID(),now,payout.pointId,payout.workplaceId,payout.cycleId,id)
      }
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }

  prepareCleanerPayout(expectedCycleId:string):CleanerPayout {
    const context=this.cleaningContext()
    this.reconcilePendingCleaner(context)
    if(!expectedCycleId)throw new Error('Укажите цикл уборки')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous=this.db.prepare('SELECT id FROM cleaning_payouts WHERE cycle_id=? AND point_id=? AND workplace_id=?')
        .get(expectedCycleId,context.pointId,context.workplaceId) as {id:string}|undefined
      if(previous){
        const payout=this.readCleaningPayout(previous.id)!
        this.db.exec('COMMIT')
        return payout
      }
      const shift=this.currentShift()
      if(!shift?.cashierId||shift.drawerPointId!==context.pointId||shift.drawerWorkplaceId!==context.workplaceId)
        throw new Error('Сначала откройте смену сотрудника на этой кассе')
      const cycle=this.localCleanerStatus(context)
      if(!cycle||cycle.cycleId!==expectedCycleId||cycle.payoutState!=='due'||
        cycle.visitsSincePayment!==cycle.everyNVisits)
        throw new Error('Цикл уборки не готов к выплате')
      const visits=this.db.prepare(`SELECT id FROM cleaning_visits
        WHERE point_id=? AND workplace_id=? AND cycle_id=? ORDER BY local_date`)
        .all(context.pointId,context.workplaceId,expectedCycleId) as Array<{id:string}>
      if(visits.length!==cycle.everyNVisits)
        throw new Error('Не все визиты цикла имеют подтверждаемые идентификаторы')
      const visitEventIds=visits.map(({id})=>{
        const legacy=this.db.prepare(`SELECT id FROM outbox
          WHERE event_type='cleaner.visit.recorded' AND json_extract(payload_json,'$.id')=?
          ORDER BY created_at LIMIT 1`).get(id) as {id:string}|undefined
        return legacy?.id||id
      })
      if(new Set(visitEventIds).size!==cycle.everyNVisits)
        throw new Error('Повторяющиеся события визитов не могут быть оплачены')
      const id=randomUUID(),now=new Date().toISOString()
      this.db.prepare(`INSERT INTO cleaning_payouts
        (id,point_id,workplace_id,cycle_id,amount_minor,every_n_visits,visit_event_ids_json,status,created_at)
        VALUES (?,?,?,?,?,?,?,'withdrawal_pending',?)`).run(
          id,context.pointId,context.workplaceId,expectedCycleId,cycle.payoutAmountMinor!,
          cycle.everyNVisits!,JSON.stringify(visitEventIds),now
        )
      this.db.prepare(`UPDATE cleaning_cycles SET payout_state='withdrawal_pending',payout_id=?,updated_at=?
        WHERE point_id=? AND workplace_id=? AND cycle_id=?`)
        .run(id,now,context.pointId,context.workplaceId,expectedCycleId)
      this.db.exec('COMMIT')
      return this.readCleaningPayout(id)!
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }

  payCleaner(_amountMinor:number):CashOperation {
    throw new Error('Выплата за уборку временно недоступна до интеграции с кассовым изъятием')
  }
  saveCashCount(countType:CashCount['countType'],lines:CashCountLine[]):CashCount {
    const shift=this.currentShift();if(!shift)throw new Error('Сначала откройте смену')
    const normalized=lines.filter((x)=>Number.isInteger(x.denominationMinor)&&x.denominationMinor>0&&Number.isInteger(x.quantity)&&x.quantity>=0)
    const totalMinor=normalized.reduce((sum,x)=>sum+x.denominationMinor*x.quantity,0)
    const snapshot=this.getShiftSummary()
    const drawerOpening=countType==='opening'&&Boolean(shift.drawerPointId&&shift.drawerWorkplaceId)
    const expectedMinor=drawerOpening?(shift.openingExpectedMinor??0):snapshot.expectedCashMinor
    const expectedVerified=drawerOpening?Boolean(shift.openingExpectedVerified):snapshot.expectedCashVerified!==false
    const count:CashCount={
      id:randomUUID(),countType,lines:normalized,totalMinor,expectedMinor,expectedVerified,
      differenceMinor:totalMinor-expectedMinor,createdAt:new Date().toISOString()
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO cash_counts
        (id,shift_id,count_type,lines_json,total_minor,expected_minor,expected_verified,difference_minor,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(count.id,shift.id,countType,JSON.stringify(normalized),totalMinor,expectedMinor,expectedVerified?1:0,count.differenceMinor,count.createdAt)
      if(countType==='opening'&&shift.drawerPointId&&shift.drawerWorkplaceId){
        if(!expectedVerified){
          this.updateCashDrawerBaselineFromStoredCountInTransaction(shift.drawerPointId,shift.drawerWorkplaceId,count,count.createdAt)
          this.db.prepare('UPDATE shifts SET opening_expected_minor=?,opening_expected_verified=1,accounting_baseline_at=? WHERE id=?')
            .run(totalMinor,count.createdAt,shift.id)
        }else{
          this.updateCashDrawerPendingInTransaction(shift.drawerPointId,shift.drawerWorkplaceId,false,count.createdAt)
        }
      }
      this.queue('cash.counted',{...count,shiftId:shift.id},count.createdAt)
      this.db.exec('COMMIT')
      return count
    } catch(error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  getLastCashCount():CashCount|null {
    const shift=this.currentShift();if(!shift)return null
    const row=this.db.prepare(`SELECT id,count_type countType,lines_json lines,total_minor totalMinor,
      expected_minor expectedMinor,difference_minor differenceMinor,created_at createdAt
      FROM cash_counts WHERE shift_id=? ORDER BY created_at DESC LIMIT 1`).get(shift.id) as (Omit<CashCount,'lines'>&{lines:string})|undefined
    return row?{...row,lines:JSON.parse(row.lines) as CashCountLine[]}:null
  }

  listOrders():Order[] {
    return (this.db.prepare(`SELECT id,order_number orderNumber,phone,contact_method contactMethod,customer_name customerName,lines_json lines,
      total_minor totalMinor,paid_minor paidMinor,status,comment,created_at createdAt,due_at dueAt,ready_at readyAt,issued_at issuedAt,
      source_sale_id sourceSaleId,fiscal_number fiscalNumber FROM orders ORDER BY created_at DESC LIMIT 5000`).all() as any[])
      .map((x)=>({...x,lines:JSON.parse(x.lines),paymentStatus:x.paidMinor>=x.totalMinor?'paid':x.paidMinor>0?'partial':'unpaid'})) as Order[]
  }

  private parseBankingEvidence(value:string|null|undefined):BankingEvidence|undefined {
    if(!value)return undefined
    try{return JSON.parse(value) as BankingEvidence}catch{return undefined}
  }

  private createPaidOrderFromSaleSnapshot(
    input:{id:string;createdAt:string;lines:CartLine[];totalMinor:number;customerId?:string;customerName?:string;fiscalNumber:string},
    meta:{phone:string;contactMethod?:string;comment?:string;dueAt?:string},
    trustedCashierId?:string,
  ):Order {
    const phone=meta.phone.trim()
    const contactMethod=meta.contactMethod?.trim()||undefined
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
      id,orderNumber,phone,contactMethod,customerName:customer?.name||input.customerName,
      lines:input.lines,totalMinor:input.totalMinor,paidMinor:input.totalMinor,paymentStatus:'paid',status:'in_progress',
      comment,createdAt:now,dueAt,sourceSaleId:input.id,fiscalNumber:input.fiscalNumber
    }
    this.db.prepare(`INSERT INTO orders
      (id,order_number,phone,contact_method,customer_id,customer_name,lines_json,total_minor,paid_minor,status,comment,due_at,source_sale_id,fiscal_number,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(order.id,order.orderNumber,order.phone,order.contactMethod??null,customer?.id||input.customerId||null,order.customerName||null,JSON.stringify(order.lines),
        order.totalMinor,order.paidMinor,order.status,order.comment??null,order.dueAt??null,order.sourceSaleId??null,order.fiscalNumber??null,now,now)
    this.queue('order.created',order,now,trustedCashierId)
    return order
  }

  findOrderBySourceSale(saleId:string):Order|undefined {
    return this.listOrders().find((x)=>x.sourceSaleId===saleId)
  }

  createOrderFromSale(input:{saleId:string;phone:string;contactMethod?:string;comment:string;dueAt:string},trustedCashierId?:string):Order {
    const sale=this.getSale(input.saleId)
    if(sale.status!=='completed')throw new Error('Заказ можно создать только по завершённой оплаченной продаже без возврата')
    return this.createPaidOrderFromSaleSnapshot({
      id:sale.id,createdAt:new Date().toISOString(),lines:sale.lines,totalMinor:sale.totalMinor,
      customerName:sale.customerName,fiscalNumber:sale.receiptNumber
    },input,trustedCashierId)
  }

  createUnpaidOrder(input:CreateUnpaidOrderRequest,trustedCashierId?:string):Order {
    if(!input.phone.trim()||input.phone.replace(/\D/g,'').length<5)throw new Error('Укажите телефон покупателя')
    if(!input.lines.length)throw new Error('Заказ пуст')
    const now=new Date().toISOString(),id=randomUUID(),orderNumber=`ORD-${now.slice(0,10).replace(/-/g,'')}-${id.slice(0,6).toUpperCase()}`
    const totalMinor=input.lines.reduce((s,x)=>s+Math.round(x.quantity*x.unitPriceMinor*(1-(x.discountPercent||0)/100)),0)
    if(totalMinor<=0)throw new Error('Сумма заказа должна быть больше нуля')
    const contactMethod=input.contactMethod?.trim()||undefined
    const order:Order={id,orderNumber,phone:input.phone.trim(),contactMethod,lines:input.lines,totalMinor,paidMinor:0,paymentStatus:'unpaid',status:'new',comment:input.comment?.trim()||undefined,createdAt:now,dueAt:input.dueAt}
    this.db.prepare(`INSERT INTO orders (id,order_number,phone,contact_method,lines_json,total_minor,paid_minor,status,comment,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,orderNumber,order.phone,order.contactMethod??null,JSON.stringify(order.lines),totalMinor,0,'new',order.comment||null,order.dueAt||null,now,now)
    this.queue('order.created',order,now,trustedCashierId)
    return order
  }

  updateOrder(input:UpdateOrderRequest,trustedCashierId?:string):Order {
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
      contactMethod:input.contactMethod===undefined?current.contactMethod:input.contactMethod.trim()||undefined,
      comment:input.comment===undefined?current.comment:input.comment.trim(),
      status:input.status||current.status,
      dueAt:normalizedDueAt,
    }
    const updatedAt=new Date().toISOString()
    const readyAt=current.readyAt||(input.status==='ready'&&current.status!=='ready'?updatedAt:undefined)
    const issuedAt=current.issuedAt||(input.status==='issued'&&current.status!=='issued'?updatedAt:undefined)
    this.db.prepare('UPDATE orders SET phone=?,contact_method=?,comment=?,status=?,due_at=?,ready_at=?,issued_at=?,updated_at=? WHERE id=?')
      .run(next.phone,next.contactMethod??null,next.comment||null,next.status,next.dueAt||null,readyAt||null,issuedAt||null,updatedAt,input.id)
    const result={...next,readyAt,issuedAt}
    this.queue('order.updated',result,updatedAt,trustedCashierId)
    return result
  }

  holdReceipt(input:Omit<HeldReceipt,'id'|'createdAt'>):HeldReceipt {const x={...input,id:randomUUID(),createdAt:new Date().toISOString()};this.db.prepare('INSERT INTO held_receipts (id,label,payload_json,created_at) VALUES (?,?,?,?)').run(x.id,x.label,JSON.stringify(x),x.createdAt);return x}
  listHeldReceipts():HeldReceipt[]{return (this.db.prepare('SELECT payload_json payload FROM held_receipts ORDER BY created_at DESC').all() as Array<{payload:string}>).map((x)=>JSON.parse(x.payload) as HeldReceipt)}
  deleteHeldReceipt(id:string):void{this.db.prepare('DELETE FROM held_receipts WHERE id=?').run(id)}

  private queue(eventType:string,payload:unknown,createdAt=new Date().toISOString(),trustedCashierId?:string,eventId:string=randomUUID()):void {
    const value=payload&&typeof payload==='object'?payload as Record<string,unknown>:undefined
    const shiftId=String(value?.shiftId||value?.shift_id||'')
    const shift=(shiftId
      ?this.db.prepare('SELECT cashier_id cashierId FROM shifts WHERE id=?').get(shiftId)
      :this.db.prepare('SELECT cashier_id cashierId FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1').get()) as {cashierId:string}|undefined
    const securedPayload=value&&trustedCashierId
      ?{...value,cashierId:trustedCashierId}
      :value&&shift?.cashierId?{...value,cashierId:shift.cashierId}:payload
    this.db.prepare('INSERT INTO outbox (id,event_type,payload_json,created_at) VALUES (?,?,?,?)').run(eventId,eventType,JSON.stringify(securedPayload),createdAt)
  }
  pendingEvents(limit=100):OutboxEvent[]{return (this.db.prepare(`SELECT id,event_type eventType,payload_json payload,created_at createdAt
    FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT ?`).all(limit) as Array<{id:string;eventType:string;payload:string;createdAt:string}>)
    .map((x)=>({...x,payload:JSON.parse(x.payload)}))}
  markEventsSent(ids:string[]):void {if(!ids.length)return;const mark=this.db.prepare('UPDATE outbox SET sent_at=? WHERE id=?');const now=new Date().toISOString();this.db.exec('BEGIN');try{ids.forEach((id)=>mark.run(now,id));this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}}
  pendingSyncCount():number{return (this.db.prepare('SELECT COUNT(*) count FROM outbox WHERE sent_at IS NULL').get() as {count:number}).count}
  setState(key:string,value:string):void{this.db.prepare('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
  getState(key:string):string|undefined{return (this.db.prepare('SELECT value FROM app_state WHERE key=?').get(key) as {value:string}|undefined)?.value}
  getUpsellCursor(triggerItem:string):number {
    const raw=this.getState(`upsell_cursor:${triggerItem}`)
    const value=raw===undefined?0:Number.parseInt(raw,10)
    return Number.isFinite(value)&&value>=0?value:0
  }
  setUpsellCursor(triggerItem:string,cursor:number):void {
    this.setState(`upsell_cursor:${triggerItem}`,String(Math.max(0,Math.trunc(cursor))))
  }
}
