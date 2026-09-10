import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { DiagnosticEvent } from '../shared/contracts'

export class PosDiagnostics {
  private readonly db: DatabaseSync

  constructor(filePath:string){
    this.db=new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS diagnostic_events (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL CHECK(level IN ('info','warning','error')),
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        operation_id TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_diagnostic_events_created
        ON diagnostic_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_diagnostic_events_operation
        ON diagnostic_events(operation_id, created_at DESC);
    `)
  }

  close():void{this.db.close()}

  record(input:{
    level?:DiagnosticEvent['level']
    source:DiagnosticEvent['source']
    eventType:string
    message:string
    operationId?:string
    details?:Record<string,unknown>
  }):DiagnosticEvent{
    const event:DiagnosticEvent={
      id:randomUUID(),
      level:input.level??'info',
      source:input.source,
      eventType:input.eventType,
      message:input.message,
      operationId:input.operationId,
      details:input.details,
      createdAt:new Date().toISOString()
    }
    this.db.prepare(`INSERT INTO diagnostic_events
      (id,level,source,event_type,message,operation_id,details_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(event.id,event.level,event.source,event.eventType,event.message,event.operationId??null,
        event.details?JSON.stringify(event.details):null,event.createdAt)
    this.db.exec(`DELETE FROM diagnostic_events WHERE id NOT IN (
      SELECT id FROM diagnostic_events ORDER BY created_at DESC,rowid DESC LIMIT 5000
    )`)
    return event
  }

  list(limit=200):DiagnosticEvent[]{
    const safeLimit=Math.max(1,Math.min(500,Math.floor(limit)||200))
    return (this.db.prepare(`SELECT id,level,source,event_type eventType,message,
      operation_id operationId,details_json detailsJson,created_at createdAt
      FROM diagnostic_events ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(safeLimit) as any[])
      .map((row)=>({
        id:row.id,
        level:row.level,
        source:row.source,
        eventType:row.eventType,
        message:row.message,
        operationId:row.operationId||undefined,
        details:row.detailsJson?JSON.parse(row.detailsJson):undefined,
        createdAt:row.createdAt
      }))
  }
}
