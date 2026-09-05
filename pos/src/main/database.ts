import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { CartLine, Product, Shift } from '../shared/contracts'

export class PosDatabase {
  private readonly db: Database.Database

  constructor(filePath: string) {
    this.db = new Database(filePath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
    this.seedDemoProducts()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sku TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        price_minor INTEGER NOT NULL CHECK(price_minor >= 0),
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        cashier_name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY,
        client_request_id TEXT NOT NULL UNIQUE,
        shift_id TEXT NOT NULL,
        total_minor INTEGER NOT NULL,
        payment_method TEXT NOT NULL,
        payment_transaction_id TEXT NOT NULL,
        fiscal_number TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (shift_id) REFERENCES shifts(id)
      );

      CREATE TABLE IF NOT EXISTS sale_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price_minor INTEGER NOT NULL,
        FOREIGN KEY (sale_id) REFERENCES sales(id)
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
    `)
  }

  private seedDemoProducts(): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO products (id, name, sku, category, price_minor)
      VALUES (@id, @name, @sku, @category, @priceMinor)
    `)
    const products: Product[] = [
      { id: 'print-bw-a4', name: 'Печать ч/б A4', sku: 'SVC-001', category: 'Печать', priceMinor: 2000 },
      { id: 'print-color-a4', name: 'Печать цветная A4', sku: 'SVC-002', category: 'Печать', priceMinor: 4000 },
      { id: 'scan-a4', name: 'Сканирование A4', sku: 'SVC-003', category: 'Документы', priceMinor: 5000 },
      { id: 'photo-10x15', name: 'Фото 10×15', sku: 'SVC-004', category: 'Фото', priceMinor: 3500 },
      { id: 'lamination-a4', name: 'Ламинирование A4', sku: 'SVC-005', category: 'Документы', priceMinor: 8000 },
      { id: 'envelope-c5', name: 'Конверт C5', sku: 'PRD-001', category: 'Товары', priceMinor: 2500 }
    ]
    const transaction = this.db.transaction(() => products.forEach((product) => insert.run(product)))
    transaction()
  }

  listProducts(): Product[] {
    return this.db.prepare(`
      SELECT id, name, sku, category, price_minor AS priceMinor
      FROM products WHERE active = 1 ORDER BY category, name
    `).all() as Product[]
  }

  currentShift(): Shift | null {
    return (this.db.prepare(`
      SELECT id, opened_at AS openedAt, cashier_name AS cashierName
      FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1
    `).get() as Shift | undefined) ?? null
  }

  openShift(shift: Shift): Shift {
    const current = this.currentShift()
    if (current) return current
    this.db.prepare(`INSERT INTO shifts (id, opened_at, cashier_name) VALUES (?, ?, ?)`)
      .run(shift.id, shift.openedAt, shift.cashierName)
    return shift
  }

  findSaleByClientRequestId(clientRequestId: string): { saleId: string; receiptNumber: string; totalMinor: number } | null {
    return (this.db.prepare(`
      SELECT id AS saleId, fiscal_number AS receiptNumber, total_minor AS totalMinor
      FROM sales WHERE client_request_id = ?
    `).get(clientRequestId) as { saleId: string; receiptNumber: string; totalMinor: number } | undefined) ?? null
  }

  saveSale(input: {
    id: string
    clientRequestId: string
    shiftId: string
    totalMinor: number
    paymentMethod: string
    paymentTransactionId: string
    fiscalNumber: string
    createdAt: string
    lines: CartLine[]
  }): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sales (
          id, client_request_id, shift_id, total_minor, payment_method,
          payment_transaction_id, fiscal_number, created_at
        ) VALUES (@id, @clientRequestId, @shiftId, @totalMinor, @paymentMethod,
          @paymentTransactionId, @fiscalNumber, @createdAt)
      `).run(input)

      const insertLine = this.db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, name, quantity, unit_price_minor)
        VALUES (?, ?, ?, ?, ?)
      `)
      input.lines.forEach((line) => insertLine.run(
        input.id, line.productId, line.name, line.quantity, line.unitPriceMinor
      ))

      this.db.prepare(`
        INSERT INTO outbox (id, event_type, payload_json, created_at)
        VALUES (?, 'sale.completed', ?, ?)
      `).run(randomUUID(), JSON.stringify(input), input.createdAt)
    })
    transaction()
  }

  pendingSyncCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM outbox WHERE sent_at IS NULL').get() as { count: number }
    return row.count
  }
}
