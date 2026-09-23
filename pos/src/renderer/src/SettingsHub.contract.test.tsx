import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { canCancelSyncQueueEvent, canRetrySyncQueueEvent } from '../../main/sync-queue-policy'
import type { OutboxQueueItem, SyncQueueSnapshot } from '../../shared/contracts'
import SettingsHub, {
  buildSettingsStatusItems,
  SETTINGS_OPEN_TRIGGER_SELECTOR,
  SettingsAdminGate,
  SettingsSyncQueue,
  resolveSettingsAdminGate,
  saveConnectionWithConfigurationRefresh,
  settingsGateStateAfterVerification,
} from './SettingsHub'

describe('DEV-163 unified SettingsHub contract',()=>{
  it('uses the explicit settings trigger selector instead of nav position',()=>{
    expect(SETTINGS_OPEN_TRIGGER_SELECTOR).toBe('.settings-open-trigger')
  })

  it('renders the shared one-input four-slot admin PIN gate',()=>{
    const markup=renderToStaticMarkup(
      <SettingsAdminGate
        password="12"
        error=""
        onPasswordChange={()=>undefined}
        onCancel={()=>undefined}
        onSubmit={()=>undefined}
      />
    )
    expect(markup).toContain('pin-entry-layout')
    expect(markup).toContain('pin-entry-main')
    expect(markup).toContain('pin-entry-content')
    expect((markup.match(/<input/g)||[]).length).toBe(1)
    expect((markup.match(/pin-input-control/g)||[]).length).toBe(1)
    expect((markup.match(/<span class="/g)||[]).length).toBe(4)
    expect(markup).toContain('maxLength="4"')
    expect(markup).toContain('inputMode="numeric"')
    expect(markup).toMatch(/autofocus=""/i)
  })

  it('keeps admin gate on shared PinInput with native Enter submit and unchanged callbacks',()=>{
    const source=readFileSync(new URL('./SettingsHub.tsx',import.meta.url),'utf8')
    expect(source.match(/<PinInput/g)?.length).toBe(1)
    expect(source).toContain('<form')
    expect(source).toContain('onSubmit={(event) =>')
    expect(source).toContain('event.preventDefault();')
    expect(source).toContain('onSubmit();')
    expect(source).toContain('onChange={onPasswordChange}')
    expect(source).not.toMatch(/onKey(?:Down|Up|Press)=/)
  })

  it('keeps a wrong admin code at the gate and does not open settings',async()=>{
    const seen:string[]=[]
    const state=await resolveSettingsAdminGate('1234',async(code)=>{seen.push(code);return false})
    expect(seen).toEqual(['1234'])
    expect(state).toEqual({
      gateOpen:true,
      open:false,
      gateError:'Неверный пароль',
    })
  })

  it('opens the one full SettingsHub after successful main-process verification',()=>{
    const state=settingsGateStateAfterVerification(true)
    expect(state).toEqual({gateOpen:false,open:true,gateError:''})
    const markup=renderToStaticMarkup(
      <SettingsHub initialGateOpen={state.gateOpen} initialOpen={state.open}/>
    )
    expect(markup).toContain('Распечатка OS и точка')
    expect(markup).toContain('ККТ АТОЛ')
    expect(markup).toContain('Эквайринг INPAS / PAX')
    expect(markup).toContain('Принтер товарного чека')
    expect(markup).toContain('Незавершённые операции')
    expect(markup).toContain('Диагностика')
    expect(markup).not.toContain('API key')
    expect(markup).not.toContain('API secret')
    expect(markup).not.toContain('Код рабочего места')
  })

  it('shows six independent health channels with unknown OFD distinct from KKT',()=>{
    const items=buildSettingsStatusItems({
      os:{ready:false,status:'offline',message:'backend'},
      fiscal:{ready:true,status:'ready',message:'KKT'},
      ofd:{ready:false,status:'unknown',message:'no evidence'},
      payment:{ready:false,status:'offline',message:'PAX'},
      remotePayment:{ready:false,status:'offline',message:'remote'},
      printer:{ready:true,status:'ready',message:'printer'},
      shift:{ready:true,message:'Смена открыта'},
    } as any)
    expect(items.map(([label])=>label)).toEqual([
      'OS','ККТ и ФН','Передача в ОФД','Эквайринг','Удалённая оплата','Принтер',
    ])
    expect(items[0][2]).toBe('Локальный режим')
    expect(items[1][2]).toBe('Готовы')
    expect(items[2][2]).toBe('Нет данных')
    expect(items.flat()).not.toContain('Смена')
  })

  it('does not expose the legacy Web Requests setup assistant in Settings UI',()=>{
    const markup=renderToStaticMarkup(<SettingsHub initialOpen/>)
    expect(markup).not.toContain('Первичная настройка Web Requests')
    expect(markup).not.toContain('Настроить АТОЛ 1Ф автоматически')
  })

  it('keeps diagnostics in the full hub',()=>{
    const markup=renderToStaticMarkup(<SettingsHub initialOpen/>)
    expect(markup).toContain('Диагностика')
    expect(markup).toContain('Последняя связь с OS')
    expect(markup).toContain('Техническое состояние каналов')
  })

  it('shows only human queue data in the operator row and never an unsafe action',()=>{
    const queue:SyncQueueSnapshot={
      items:[
        {id:'raw-order-uuid-123',eventType:'order.created',label:'Новый заказ',createdAt:'2026-09-23T10:00:00Z',status:'pending',attemptCount:2,nextAttemptAt:null,lastError:'Повтор будет выполнен позже',canRetry:true,canCancel:false},
        {id:'raw-fiscal-uuid-456',eventType:'sale.completed',label:'Продажа',createdAt:'2026-09-23T11:00:00Z',status:'problem',attemptCount:3,nextAttemptAt:null,lastError:'Сервер отклонил данные события',canRetry:false,canCancel:false},
      ],total:2,problemCount:1,problemCountTruncated:false,
    }
    const markup=renderToStaticMarkup(<SettingsSyncQueue queue={queue} busy={false} onRetry={()=>undefined}/> )
    expect(markup).toContain('Новый заказ')
    expect(markup).toContain('Требует исправления')
    expect(markup).toContain('Попыток: 2')
    expect((markup.match(/Повторить отправку/g)||[]).length).toBe(1)
    expect(markup).not.toContain('Удалить')
    expect(markup).not.toContain('Отменить')
    expect(markup).not.toContain('raw-order-uuid-123')
    expect(markup).not.toContain('raw-fiscal-uuid-456')
    expect(markup).not.toContain('order.created')
    const legacy=renderToStaticMarkup(<SettingsSyncQueue queue={{...queue,items:[{...queue.items[0],lastError:'TypeError: /workspace/private/token.json {secret}'}]}} busy={false} onRetry={()=>undefined}/> )
    expect(legacy).toContain('Откройте диагностику')
    expect(legacy).not.toContain('/workspace/private/token.json')
    expect(legacy).not.toContain('TypeError')
  })

  it('rejects unsafe, delayed and unversioned retries by the main policy',()=>{
    const event:OutboxQueueItem={id:'e',eventType:'order.created',payload:{},createdAt:'2026-09-23T10:00:00Z',status:'pending',attemptCount:1,lastAttemptAt:null,nextAttemptAt:null,lastError:null,sentAt:null}
    const now=Date.parse('2026-09-23T12:00:00Z')
    expect(canRetrySyncQueueEvent(event,false,now)).toBe(true)
    for(const eventType of ['sale.completed','sale.returned','shift.opened','shift.closed','cash.deposited','cash.withdrawn','cash.counted','payment_unknown','fiscal_status_unknown']){
      expect(canRetrySyncQueueEvent({...event,eventType},false,now)).toBe(false)
    }
    expect(canRetrySyncQueueEvent({...event,status:'problem'},false,now)).toBe(false)
    expect(canRetrySyncQueueEvent({...event,nextAttemptAt:'2026-09-24T00:00:00Z'},false,now)).toBe(false)
    expect(canRetrySyncQueueEvent(event,true,now)).toBe(false)
    expect(canRetrySyncQueueEvent({...event,eventType:'order.updated'},false,now)).toBe(false)
    expect(canRetrySyncQueueEvent({...event,eventType:'order.updated',payload:{updatedAt:'2026-09-23T10:00:00Z'}},false,now)).toBe(true)
    for(const eventType of ['order.created','order.updated','sale.completed','cash.withdrawn']){
      expect(canCancelSyncQueueEvent({...event,eventType})).toBe(false)
    }
  })

  it('uses configuration refresh after admin connection save without full sync',async()=>{
    const calls:string[]=[]
    const api:any={
      saveConnection:async()=>{calls.push('save')},
      syncConfiguration:async()=>{calls.push('configuration');return {pointId:'point',pointName:'Point'}},
      syncNow:async()=>{calls.push('full');return {}},
    }
    await expect(saveConnectionWithConfigurationRefresh(api,{serverUrl:'https://example.test',deviceId:'POS-1',token:'token'}))
      .resolves.toMatchObject({pointId:'point'})
    expect(calls).toEqual(['save','configuration'])
  })


  it('uses shared settings actions and accessible fields without exposing provider setup copy',()=>{
    const markup=renderToStaticMarkup(<SettingsHub initialOpen/>)
    expect(markup).toContain('pos-button--primary')
    expect(markup).toContain('pos-button--secondary')
    expect(markup).toContain('pos-field__label')
    expect(markup).toContain('aria-label="Закрыть настройки"')
    expect(markup).not.toMatch(/🟢|🟠/)
    expect(markup).not.toContain('Первичная настройка Web Requests')
  })

  it('does not render obsolete POS Ready controls or copy',()=>{
    const markup=renderToStaticMarkup(<SettingsHub initialOpen/>)
    expect(markup).not.toContain('POS Ready')
    expect(markup).not.toContain('Подключение POS Ready')
  })
})
