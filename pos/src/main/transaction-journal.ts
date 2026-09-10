import { DatabaseSync } from 'node:sqlite'
import type { CompleteSaleRequest, CreateReturnRequest, PaymentPart } from '../shared/contracts'

export type TransactionKind = 'sale' | 'return'
export type TransactionState =
  | 'created'
  | 'payment_in_progress'
  | 'payment_confirmed'
  | 'payment_unknown'
  | 'fiscalization_in_progress'
  | 'fiscalized'
  | 'fiscal_status_unknown'
  | 'completed'
  | 'requires_attention'

export type JournalOperation = {
  id: string
  clientRequestId: string
  kind: TransactionKind
  entityId: string
  relatedSaleId?: string
  shiftId: string
  amountMinor: number
  state: TransactionState
  request: CompleteSaleRequest | CreateReturnRequest
  confirmedPayments: PaymentPart[]
  fiscalReceiptNumber?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

export type JournalOperationSummary = Omit<JournalOperation, 'request' | 'confirmedPayments'> & {
  paymentMethods: string[]
}

const ACTIVE_STATES: TransactionState[] = [
  'created',
  'payment_in_progress',
  'payment_confirmed',
  'payment_unknown',
  'fiscalization_in_progress',
  'fiscalized',
  'fiscal_status_unknown',
  'requires_attention'
]

export class TransactionJournal {
  private readonly db: DatabaseSync

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA synchronous = FULL')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        client_request_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('sale','return')),
        entity_id TEXT NOT NULL UNIQUE,
        related_sale_id TEXT,
        shift_id TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
        state TEXT NOT NULL,
        request_json TEXT NOT NULL,
        confirmed_payments_json TEXT NOT NULL DEFAULT '[]',
        fiscal_receipt_number TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operations_state_updated
        ON operations(state, updated_at);
      CREATE TABLE IF NOT EXISTS payment_attempts (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('charge','refund')),
        method TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        state TEXT NOT NULL,
        transaction_id TEXT,
        raw_result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(operation_id) REFERENCES operations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_payment_attempts_operation
        ON payment_attempts(operation_id, started_at);
      CREATE TABLE IF NOT EXISTS fiscal_attempts (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('sale','return')),
        state TEXT NOT NULL,
        receipt_number TEXT,
        raw_result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(operation_id) REFERENCES operations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_fiscal_attempts_operation
        ON fiscal_attempts(operation_id, started_at);
    `)
  }

  create(input: {
    id: string
    clientRequestId: string
    kind: TransactionKind
    entityId: string
    relatedSaleId?: string
    shiftId: string
    amountMinor: number
    request: CompleteSaleRequest | CreateReturnRequest
    createdAt?: string
  }): JournalOperation {
    const existing = this.getByClientRequestId(input.clientRequestId)
    if (existing) return existing
    const now = input.createdAt ?? new Date().toISOString()
    this.db.prepare(`INSERT INTO operations
      (id,client_request_id,kind,entity_id,related_sale_id,shift_id,amount_minor,state,request_json,confirmed_payments_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.id,input.clientRequestId,input.kind,input.entityId,input.relatedSaleId??null,input.shiftId,input.amountMinor,
        'created',JSON.stringify(input.request),'[]',now,now)
    return this.get(input.id)!
  }

  get(id: string): JournalOperation | null {
    return this.rowToOperation(this.db.prepare(`SELECT id,client_request_id clientRequestId,kind,entity_id entityId,
      related_sale_id relatedSaleId,shift_id shiftId,amount_minor amountMinor,state,request_json requestJson,
      confirmed_payments_json confirmedPaymentsJson,fiscal_receipt_number fiscalReceiptNumber,last_error lastError,
      created_at createdAt,updated_at updatedAt FROM operations WHERE id=?`).get(id) as any)
  }

  getByClientRequestId(clientRequestId: string): JournalOperation | null {
    return this.rowToOperation(this.db.prepare(`SELECT id,client_request_id clientRequestId,kind,entity_id entityId,
      related_sale_id relatedSaleId,shift_id shiftId,amount_minor amountMinor,state,request_json requestJson,
      confirmed_payments_json confirmedPaymentsJson,fiscal_receipt_number fiscalReceiptNumber,last_error lastError,
      created_at createdAt,updated_at updatedAt FROM operations WHERE client_request_id=?`).get(clientRequestId) as any)
  }

  listUnresolved(): JournalOperation[] {
    const placeholders = ACTIVE_STATES.map(() => '?').join(',')
    return (this.db.prepare(`SELECT id,client_request_id clientRequestId,kind,entity_id entityId,
      related_sale_id relatedSaleId,shift_id shiftId,amount_minor amountMinor,state,request_json requestJson,
      confirmed_payments_json confirmedPaymentsJson,fiscal_receipt_number fiscalReceiptNumber,last_error lastError,
      created_at createdAt,updated_at updatedAt FROM operations WHERE state IN (${placeholders}) ORDER BY created_at`).all(...ACTIVE_STATES) as any[])
      .map((row) => this.rowToOperation(row)!)
  }

  listUnresolvedSummaries(): JournalOperationSummary[] {
    return this.listUnresolved().map((operation) => ({
      id: operation.id,
      clientRequestId: operation.clientRequestId,
      kind: operation.kind,
      entityId: operation.entityId,
      relatedSaleId: operation.relatedSaleId,
      shiftId: operation.shiftId,
      amountMinor: operation.amountMinor,
      state: operation.state,
      fiscalReceiptNumber: operation.fiscalReceiptNumber,
      lastError: operation.lastError,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      paymentMethods: operation.confirmedPayments.map((payment) => payment.method)
    }))
  }

  setState(id: string, state: TransactionState, error?: string): void {
    this.db.prepare('UPDATE operations SET state=?,last_error=?,updated_at=? WHERE id=?')
      .run(state,error??null,new Date().toISOString(),id)
  }

  setConfirmedPayments(id: string, payments: PaymentPart[]): void {
    this.db.prepare('UPDATE operations SET confirmed_payments_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(payments),new Date().toISOString(),id)
  }

  setFiscalReceipt(id: string, receiptNumber: string): void {
    this.db.prepare('UPDATE operations SET fiscal_receipt_number=?,updated_at=? WHERE id=?')
      .run(receiptNumber,new Date().toISOString(),id)
  }

  startPaymentAttempt(input: {id:string;operationId:string;action:'charge'|'refund';method:string;amountMinor:number;startedAt?:string}): void {
    this.db.prepare(`INSERT OR IGNORE INTO payment_attempts
      (id,operation_id,action,method,amount_minor,state,started_at) VALUES (?,?,?,?,?,?,?)`)
      .run(input.id,input.operationId,input.action,input.method,input.amountMinor,'in_progress',input.startedAt??new Date().toISOString())
  }

  finishPaymentAttempt(input: {id:string;state:'approved'|'declined'|'unknown';transactionId?:string;rawResult?:unknown;error?:string}): void {
    this.db.prepare(`UPDATE payment_attempts SET state=?,transaction_id=?,raw_result_json=?,error=?,completed_at=? WHERE id=?`)
      .run(input.state,input.transactionId??null,input.rawResult===undefined?null:JSON.stringify(input.rawResult),input.error??null,new Date().toISOString(),input.id)
  }

  startFiscalAttempt(input: {id:string;operationId:string;action:'sale'|'return';startedAt?:string}): void {
    this.db.prepare(`INSERT OR IGNORE INTO fiscal_attempts
      (id,operation_id,action,state,started_at) VALUES (?,?,?,?,?)`)
      .run(input.id,input.operationId,input.action,'in_progress',input.startedAt??new Date().toISOString())
  }

  finishFiscalAttempt(input: {id:string;state:'fiscalized'|'failed'|'unknown';receiptNumber?:string;rawResult?:unknown;error?:string}): void {
    this.db.prepare(`UPDATE fiscal_attempts SET state=?,receipt_number=?,raw_result_json=?,error=?,completed_at=? WHERE id=?`)
      .run(input.state,input.receiptNumber??null,input.rawResult===undefined?null:JSON.stringify(input.rawResult),input.error??null,new Date().toISOString(),input.id)
  }

  getLatestPaymentAttempt(operationId: string): null | {
    id:string; action:'charge'|'refund'; method:string; amountMinor:number; state:string; transactionId?:string
  } {
    const row = this.db.prepare(`SELECT id,action,method,amount_minor amountMinor,state,transaction_id transactionId
      FROM payment_attempts WHERE operation_id=? ORDER BY started_at DESC LIMIT 1`).get(operationId) as any
    return row ?? null
  }

  getLatestFiscalAttempt(operationId: string): null | {
    id:string; action:'sale'|'return'; state:string; receiptNumber?:string
  } {
    const row = this.db.prepare(`SELECT id,action,state,receipt_number receiptNumber
      FROM fiscal_attempts WHERE operation_id=? ORDER BY started_at DESC LIMIT 1`).get(operationId) as any
    return row ?? null
  }

  private rowToOperation(row: any): JournalOperation | null {
    if (!row) return null
    return {
      id: row.id,
      clientRequestId: row.clientRequestId,
      kind: row.kind,
      entityId: row.entityId,
      relatedSaleId: row.relatedSaleId || undefined,
      shiftId: row.shiftId,
      amountMinor: Number(row.amountMinor),
      state: row.state,
      request: JSON.parse(row.requestJson),
      confirmedPayments: JSON.parse(row.confirmedPaymentsJson || '[]'),
      fiscalReceiptNumber: row.fiscalReceiptNumber || undefined,
      lastError: row.lastError || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }
}
