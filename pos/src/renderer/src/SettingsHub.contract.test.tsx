import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SettingsHub, {
  buildSettingsStatusItems,
  SETTINGS_OPEN_TRIGGER_SELECTOR,
  SettingsAdminGate,
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
    expect(markup).toContain('autoFocus=""')
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

  it('keeps only four technical status tiles and leaves shift state out of this grid',()=>{
    const items=buildSettingsStatusItems({
      os:{ready:true,message:'OS'},
      fiscal:{ready:true,message:'ККТ'},
      payment:{ready:true,message:'Эквайринг'},
      printer:{ready:true,message:'Принтер'},
      shift:{ready:true,message:'Смена открыта'},
    } as any)
    expect(items.map(([label])=>label)).toEqual(['OS','ККТ','Эквайринг','Принтер'])
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
    expect(markup).toContain('Последние технические события приложения.')
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
