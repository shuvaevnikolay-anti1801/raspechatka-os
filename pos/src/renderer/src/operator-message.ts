import type { BootState, HardwareStatus, PrintResult, RecoveryResult } from '../../shared/contracts'

type Domain='general'|'sync'|'settings'|'orders'|'work'|'receipts'|'print'|'terminal'|'payment'|'fiscal'|'shift'|'auth'
type SafeError={code?:unknown;message?:unknown;safeForOperator?:unknown;operatorSafe?:unknown}

const unsafeText=/(?:[a-z]:[\\/]|\\\\|\/(?:home|users|workspace|tmp|opt|var|etc)\/|https?:\/\/|\b[0-9a-f]{8}-[0-9a-f-]{16,}\b|\b(?:Error|Exception|Traceback|TypeError|RangeError|ECONN\w*|ENOENT|EACCES|HTTP|IPC|DCConsole|processJson|exitCode|statusCode)\b|\b(?:sale|order|shift|cash|stock|cleaner|point)\.[a-z_.]+\b|[{}\[\]]|\n|\r|\b0x[0-9a-f]+\b)/i
const safeCodes=new Set(['VALIDATION_ERROR','BUSINESS_RULE','INVALID_INPUT','POINT_RULE'])

/** Only explicitly marked business validation crosses into ordinary operator copy. */
export function safeValidationText(error:unknown):string|undefined{
  if(!error||typeof error!=='object')return undefined
  const value=error as SafeError
  if(value.safeForOperator!==true&&value.operatorSafe!==true)return undefined
  if(typeof value.code!=='string'||!safeCodes.has(value.code.toUpperCase()))return undefined
  if(typeof value.message!=='string')return undefined
  const message=value.message.trim()
  return message.length>0&&message.length<=180&&!unsafeText.test(message)?message:undefined
}

const unknownOutcome=(error:unknown)=>{
  const value=error as SafeError|null
  const code=typeof value?.code==='string'?value.code.toLowerCase():''
  const raw=typeof value?.message==='string'?value.message:error instanceof Error?error.message:typeof error==='string'?error:''
  return /payment_unknown|fiscal_status_unknown|unknown_outcome/.test(code)||
    /payment_unknown|fiscal_status_unknown|(?:неизвестн|не подтвержд)[^.!\n]{0,100}(?:результат|оплат|фискал)|(?:результат|оплат|фискал)[^.!\n]{0,100}(?:неизвестн|не подтвержд)/i.test(raw)
}

const recovery='Проверьте «Незавершённые операции» и диагностику. Не повторяйте оплату или фискализацию без сверки.'

export function operatorError(error:unknown,domain:Domain='general'):string{
  if(unknownOutcome(error))return 'Результат оплаты или фискализации не подтверждён. '+recovery
  const safe=safeValidationText(error)
  if(safe)return safe
  if(domain==='payment'||domain==='fiscal'||domain==='terminal'||domain==='shift')
    return 'Не удалось подтвердить состояние операции. '+recovery
  const messages:Record<Exclude<Domain,'payment'|'fiscal'|'terminal'|'shift'>,string>={
    general:'Действие не завершено. Проверьте состояние и повторите позже.',
    sync:'Не удалось обновить данные. Работа на кассе продолжается локально; проверьте очередь синхронизации.',
    settings:'Не удалось обновить настройки. Проверьте состояние подключения и диагностику.',
    orders:'Действие с заказом не завершено. Проверьте заказ и повторите позже.',
    work:'Действие не завершено. Проверьте данные точки и повторите позже.',
    receipts:'Не удалось получить чек. Проверьте подключение и повторите позже.',
    print:'Не удалось напечатать чек. Проверьте принтер и очередь печати.',
    auth:'Не удалось выполнить вход. Проверьте данные и повторите попытку.',
  }
  return messages[domain]
}

export function operatorSyncMessage(result:Pick<BootState,'pendingSync'|'documentQueueError'|'masterDataError'|'documentQueueSynced'>):string{
  const pending=Math.max(0,result.pendingSync||0)
  if(result.documentQueueError||pending>0||result.documentQueueSynced===false){
    const master=result.masterDataError?' Справочники также не обновлены.':''
    return `Связь с OS есть, но не все документы отправлены. В очереди: ${pending}. Проверьте «Очередь синхронизации».${master}`
  }
  if(result.masterDataError)return 'Документы отправлены, но справочники не обновлены. Проверьте подключение и диагностику.'
  return 'Данные и очередь документов обновлены.'
}

export function operatorRecoveryMessage(result:RecoveryResult):string{
  return result.status==='completed'?'Операция сверена. Проверьте её итог в чеке и списке операций.':
    'Результат операции пока не подтверждён. '+recovery
}

export function operatorPrintMessage(result:PrintResult):string{
  return result.status==='printed'?'Чек отправлен на печать.':'Печать смоделирована; физический чек не напечатан.'
}

export function operatorTerminalMessage(health:HardwareStatus):string{
  return health.ready?'Терминал готов':health.status==='not_configured'?'Терминал не настроен':
    health.status==='busy'?'Терминал занят':'Терминал не готов. Проверьте связь в настройках.'
}
