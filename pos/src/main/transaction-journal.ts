import { DatabaseSync } from 'node:sqlite'
import type { BankingEvidence, CompleteSaleRequest, CreateReturnRequest, PaymentPart } from '../shared/contracts'
import type { FiscalRecoverySnapshot, PaymentResult } from './providers/contracts'

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
  | 'cancelled'
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
  canCancel: boolean
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
        provider TEXT,
        adapter TEXT,
        terminal_id TEXT,
        reference_number TEXT,
        terminal_transaction_id TEXT,
        authorization_code TEXT,
        response_code TEXT,
        request_hash TEXT,
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
    this.ensurePaymentAttemptColumns()
    this.ensureFiscalAttemptColumns()
  }

  private ensurePaymentAttemptColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(payment_attempts)').all() as Array<{name:string}>)
        .map((column) => column.name)
    )
    const columns: Array<[string,string]> = [
      ['provider','TEXT'],
      ['adapter','TEXT'],
      ['terminal_id','TEXT'],
      ['reference_number','TEXT'],
      ['terminal_transaction_id','TEXT'],
      ['authorization_code','TEXT'],
      ['response_code','TEXT'],
      ['request_hash','TEXT']
    ]
    for (const [name,type] of columns) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE payment_attempts ADD COLUMN ${name} ${type}`)
    }
  }

  private ensureFiscalAttemptColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(fiscal_attempts)').all() as Array<{name:string}>)
        .map((column) => column.name)
    )
    const columns: Array<[string,string]> = [
      ['kkt_serial_number','TEXT'],
      ['shift_number_before','TEXT'],
      ['fiscal_document_number_before','TEXT'],
      ['kkt_datetime_before','TEXT'],
      ['request_hash','TEXT'],
      ['fiscal_document_number_after','TEXT'],
      ['fiscal_sign','TEXT'],
      ['shift_number_after','TEXT']
    ]
    for (const [name,type] of columns) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE fiscal_attempts ADD COLUMN ${name} ${type}`)
    }
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
      paymentMethods: operation.request.payments.map((payment) => payment.method),
      canCancel: this.canCancelBeforeSideEffects(operation.id)
    }))
  }

  canCancelBeforeSideEffects(id:string):boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM operations o
      WHERE o.id=? AND o.state IN ('created','requires_attention') AND o.confirmed_payments_json='[]'
      AND NOT EXISTS (SELECT 1 FROM payment_attempts p WHERE p.operation_id=o.id)
      AND NOT EXISTS (SELECT 1 FROM fiscal_attempts f WHERE f.operation_id=o.id)`).get(id))
  }

  cancelBeforeSideEffects(id:string):boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try{
      const result=this.db.prepare(`UPDATE operations SET state='cancelled',
        last_error='Операция отменена до оплаты и фискализации',updated_at=?
        WHERE id=? AND state IN ('created','requires_attention') AND confirmed_payments_json='[]'
        AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE operation_id=operations.id)
        AND NOT EXISTS (SELECT 1 FROM fiscal_attempts WHERE operation_id=operations.id)`)
        .run(new Date().toISOString(),id)
      this.db.exec('COMMIT')
      return result.changes===1
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }

  hasBlockingFiscalOperation(): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM operations o
      WHERE o.state IN ('payment_in_progress','payment_confirmed','payment_unknown',
        'fiscalization_in_progress','fiscal_status_unknown','fiscalized')
        OR (o.state='requires_attention' AND EXISTS (
          SELECT 1 FROM fiscal_attempts attempt WHERE attempt.operation_id=o.id
        ))
      LIMIT 1`).get())
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

  startPaymentAttempt(input: {
    id:string;operationId:string;action:'charge'|'refund';method:string;amountMinor:number;startedAt?:string
    provider?:string;adapter?:string;terminalId?:string;requestHash?:string
  }): void {
    this.db.prepare(`INSERT OR IGNORE INTO payment_attempts
      (id,operation_id,action,method,amount_minor,state,started_at,provider,adapter,terminal_id,request_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.id,input.operationId,input.action,input.method,input.amountMinor,'in_progress',
        input.startedAt??new Date().toISOString(),input.provider??null,input.adapter??null,
        input.terminalId??null,input.requestHash??null)
  }

  finishPaymentAttempt(input: {
    id:string;state:'approved'|'declined'|'unknown';transactionId?:string
    bankingEvidence?:BankingEvidence;rawResult?:unknown;error?:string
  }): void {
    const evidence=input.bankingEvidence
    this.db.prepare(`UPDATE payment_attempts SET state=?,transaction_id=?,raw_result_json=?,error=?,completed_at=?,
      provider=COALESCE(?,provider),adapter=COALESCE(?,adapter),terminal_id=COALESCE(?,terminal_id),
      reference_number=?,terminal_transaction_id=?,authorization_code=?,response_code=?
      WHERE id=?`)
      .run(input.state,input.transactionId??null,input.rawResult===undefined?null:JSON.stringify(input.rawResult),
        input.error??null,new Date().toISOString(),evidence?.provider??null,evidence?.adapter??null,
        evidence?.terminalId??null,evidence?.referenceNumber??null,evidence?.terminalTransactionId??null,
        evidence?.authorizationCode??null,evidence?.responseCode??null,input.id)
  }

  startFiscalAttempt(input: {
    id:string;operationId:string;action:'sale'|'return';startedAt?:string
    snapshot?:FiscalRecoverySnapshot;requestHash?:string
  }): void {
    this.db.prepare(`INSERT OR IGNORE INTO fiscal_attempts
      (id,operation_id,action,state,started_at,kkt_serial_number,shift_number_before,
       fiscal_document_number_before,kkt_datetime_before,request_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(input.id,input.operationId,input.action,'in_progress',input.startedAt??new Date().toISOString(),
        input.snapshot?.kktSerialNumber??null,input.snapshot?.shiftNumber??null,
        input.snapshot?.fiscalDocumentNumber??null,input.snapshot?.kktDateTime??null,input.requestHash??null)
  }

  finishFiscalAttempt(input: {
    id:string;state:'fiscalized'|'failed'|'unknown';receiptNumber?:string;rawResult?:unknown;error?:string
    snapshotAfter?:FiscalRecoverySnapshot
    fiscalDocumentNumberAfter?:string;fiscalSign?:string;shiftNumberAfter?:string
  }): void {
    this.db.prepare(`UPDATE fiscal_attempts SET state=?,receipt_number=?,raw_result_json=?,error=?,completed_at=?,
      fiscal_document_number_after=?,fiscal_sign=?,shift_number_after=? WHERE id=?`)
      .run(input.state,input.receiptNumber??null,input.rawResult===undefined?null:JSON.stringify(input.rawResult),
        input.error??null,new Date().toISOString(),
        input.snapshotAfter?.fiscalDocumentNumber??input.fiscalDocumentNumberAfter??null,
        input.snapshotAfter?.fiscalSign??input.fiscalSign??null,
        input.snapshotAfter?.shiftNumber??input.shiftNumberAfter??null,input.id)
  }

  getLatestPaymentAttempt(operationId: string): null | {
    id:string; action:'charge'|'refund';kind:'sale'|'refund';method:PaymentPart['method'];amountMinor:number
    state:'in_progress'|'approved'|'declined'|'unknown';transactionId?:string
    provider?:string;adapter?:string;terminalId?:string;referenceNumber?:string
    terminalTransactionId?:string;authorizationCode?:string;responseCode?:string;requestHash?:string
    startedAt?:string;completedAt?:string;bankingEvidence?:BankingEvidence;safeResult?:PaymentResult
  } {
    const row = this.db.prepare(`SELECT id,action,method,amount_minor amountMinor,state,transaction_id transactionId,
      provider,adapter,terminal_id terminalId,reference_number referenceNumber,
      terminal_transaction_id terminalTransactionId,authorization_code authorizationCode,
      response_code responseCode,request_hash requestHash,started_at startedAt,completed_at completedAt,
      raw_result_json rawResultJson
      FROM payment_attempts WHERE operation_id=? ORDER BY started_at DESC LIMIT 1`).get(operationId) as any
    if(!row)return null
    row.kind=row.action==='charge'?'sale':'refund'
    if(row.rawResultJson){
      try{
        row.safeResult=JSON.parse(row.rawResultJson) as PaymentResult
        row.bankingEvidence=row.safeResult?.bankingEvidence
      }catch{}
    }
    for(const key of ['transactionId','provider','adapter','terminalId','referenceNumber',
      'terminalTransactionId','authorizationCode','responseCode','requestHash','completedAt']){
      if(row[key]===null)row[key]=undefined
    }
    delete row.rawResultJson
    return row
  }

  getLatestFiscalAttempt(operationId: string): null | {
    id:string; action:'sale'|'return'; state:string; receiptNumber?:string
    kktSerialNumber?:string;shiftNumberBefore?:string;fiscalDocumentNumberBefore?:string
    kktDateTimeBefore?:string;requestHash?:string;fiscalDocumentNumberAfter?:string
    fiscalSign?:string;shiftNumberAfter?:string;snapshotBefore?:FiscalRecoverySnapshot;attemptStartedAt?:string
  } {
    const row = this.db.prepare(`SELECT id,action,state,receipt_number receiptNumber,
      kkt_serial_number kktSerialNumber,shift_number_before shiftNumberBefore,
      fiscal_document_number_before fiscalDocumentNumberBefore,kkt_datetime_before kktDateTimeBefore,
      request_hash requestHash,fiscal_document_number_after fiscalDocumentNumberAfter,
      fiscal_sign fiscalSign,shift_number_after shiftNumberAfter,started_at attemptStartedAt
      FROM fiscal_attempts WHERE operation_id=? ORDER BY started_at DESC LIMIT 1`).get(operationId) as any
    if(!row)return null
    row.snapshotBefore=row.kktSerialNumber?{
      kktSerialNumber:row.kktSerialNumber,
      shiftNumber:row.shiftNumberBefore||undefined,
      fiscalDocumentNumber:row.fiscalDocumentNumberBefore||undefined,
      kktDateTime:row.kktDateTimeBefore||undefined
    }:undefined
    return row
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
