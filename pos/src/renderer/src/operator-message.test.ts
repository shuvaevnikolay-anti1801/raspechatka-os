import { describe, expect, it } from 'vitest'
import {
  operatorError, operatorPrintMessage, operatorRecoveryMessage,
  operatorSyncMessage, operatorTerminalMessage, safeValidationText,
} from './operator-message'

const forbidden=['C:\\Users\\cashier\\token.json','/workspace/secret/token','sale.completed','event-123e4567-e89b-12d3-a456-426614174000','TypeError','at processJson','{ "payload": true }','DCConsole -o1 code 42']

describe('operator-facing messages',()=>{
  it('keeps paths, event identities, stack and transport details out of ordinary errors',()=>{
    for(const raw of forbidden){
      const message=operatorError(new Error(raw),'settings')
      expect(message).not.toContain(raw)
      expect(message).toContain('Проверьте')
      expect(safeValidationText({safeForOperator:true,code:'VALIDATION_ERROR',message:raw})).toBeUndefined()
    }
  })

  it('preserves only explicitly marked concise business validation',()=>{
    expect(operatorError({safeForOperator:true,code:'VALIDATION_ERROR',message:'Укажите количество больше нуля'},'orders'))
      .toBe('Укажите количество больше нуля')
    expect(operatorError({code:'VALIDATION_ERROR',message:'Укажите количество больше нуля'},'orders'))
      .not.toBe('Укажите количество больше нуля')
    expect(operatorError({safeForOperator:true,code:'BUSINESS_RULE',message:'Цена ниже минимума'},'work'))
      .toBe('Цена ниже минимума')
  })

  it('labels partial or problem sync without disclosing server event details',()=>{
    const partial=operatorSyncMessage({pendingSync:2,documentQueueError:'sale.completed (event-123): /tmp/trace',masterDataError:undefined,documentQueueSynced:false})
    expect(partial).toContain('не все документы отправлены')
    expect(partial).toContain('В очереди: 2')
    expect(partial).not.toContain('sale.completed')
    expect(partial).not.toContain('/tmp/trace')
    expect(operatorSyncMessage({pendingSync:0,documentQueueError:undefined,masterDataError:'Error: C:\\tmp',documentQueueSynced:true}))
      .toContain('справочники не обновлены')
    expect(operatorSyncMessage({pendingSync:0,documentQueueError:undefined,masterDataError:undefined,documentQueueSynced:true}))
      .toContain('очередь документов обновлены')
  })

  it('directs uncertain payment and fiscal results to recovery without blind repeat',()=>{
    for(const error of [{code:'payment_unknown',message:'bank code 42'},new Error('Фискальный результат неизвестен: C:\\secret')]){
      const message=operatorError(error,'payment')
      expect(message).toContain('Незавершённые операции')
      expect(message).toContain('Не повторяйте')
      expect(message).not.toContain('code 42')
      expect(message).not.toContain('C:\\secret')
    }
    expect(operatorRecoveryMessage({status:'attention',message:'raw /tmp/path'})).toContain('Не повторяйте')
  })

  it('maps provider results and terminal status without forwarding raw payloads',()=>{
    expect(operatorPrintMessage({kind:'commodity',status:'printed',message:'C:\\secret'})).not.toContain('secret')
    expect(operatorTerminalMessage({ready:false,status:'error',message:'DCConsole -o26 failed'})).not.toContain('DCConsole')
  })
})
