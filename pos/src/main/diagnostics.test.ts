import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { PosDiagnostics } from './diagnostics'

describe('PosDiagnostics',()=>{
  const dirs:string[]=[]
  afterEach(()=>{while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true})})

  it('keeps events across application restart',()=>{
    const dir=mkdtempSync(join(tmpdir(),'raspechatka-diagnostics-'));dirs.push(dir)
    const path=join(dir,'diagnostics.sqlite')
    const first=new PosDiagnostics(path)
    first.record({source:'fiscal',level:'error',eventType:'fiscal.failed',message:'Нет бумаги',operationId:'sale-1'})
    first.close()

    const second=new PosDiagnostics(path)
    const events=second.list()
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe('fiscal')
    expect(events[0].message).toBe('Нет бумаги')
    expect(events[0].operationId).toBe('sale-1')
    second.close()
  })

  it('returns newest events first',()=>{
    const dir=mkdtempSync(join(tmpdir(),'raspechatka-diagnostics-'));dirs.push(dir)
    const log=new PosDiagnostics(join(dir,'diagnostics.sqlite'))
    log.record({source:'app',eventType:'one',message:'Первое'})
    log.record({source:'shift',eventType:'two',message:'Второе'})
    expect(log.list(1)[0].message).toBe('Второе')
    log.close()
  })
})
