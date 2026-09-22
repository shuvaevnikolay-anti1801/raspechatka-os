import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SettingsHub, {
  SETTINGS_OPEN_TRIGGER_SELECTOR,
  SettingsAdminGate,
  resolveSettingsAdminGate,
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
    expect((markup.match(/<input/g)||[]).length).toBe(1)
    expect((markup.match(/pin-input-control/g)||[]).length).toBe(1)
    expect((markup.match(/<span class="/g)||[]).length).toBe(4)
    expect(markup).toContain('maxLength="4"')
    expect(markup).toContain('inputMode="numeric"')
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

  it('keeps diagnostics in the full hub',()=>{
    const markup=renderToStaticMarkup(<SettingsHub initialOpen/>)
    expect(markup).toContain('Диагностика')
    expect(markup).toContain('Последние технические события приложения.')
  })

  it('does not render obsolete POS Ready controls or copy',()=>{
    const markup=renderToStaticMarkup(<SettingsHub initialOpen/>)
    expect(markup).not.toContain('POS Ready')
    expect(markup).not.toContain('Подключение POS Ready')
  })
})
