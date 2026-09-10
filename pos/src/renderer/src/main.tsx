import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import CashierHotkeys from './CashierHotkeys'
import DiagnosticsList from './DiagnosticsList'
import PilotReadiness from './PilotReadiness'
import PosSafetyPanel from './PosSafetyPanel'
import ReceiptExplorer from './ReceiptExplorer'
import SaleSuccessOverlay from './SaleSuccessOverlay'
import SettingsModeGuard from './SettingsModeGuard'
import ShiftRecoveryBanner from './ShiftRecoveryBanner'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <CashierHotkeys />
    <SettingsModeGuard />
    <ShiftRecoveryBanner />
    <PosSafetyPanel />
    <PilotReadiness />
    <ReceiptExplorer />
    <SaleSuccessOverlay />
    <DiagnosticsList />
    <div className="cashier-hotkey-help">F2 поиск · F4 оплата · Ctrl+1…6 разделы · Esc закрыть</div>
  </StrictMode>
)
