import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import CashierHotkeys from './CashierHotkeys'
import ReceiptExplorer from './ReceiptExplorer'
import SaleSuccessOverlay from './SaleSuccessOverlay'
import SettingsHub from './SettingsHub'
import ShiftCloseGuard from './ShiftCloseGuard'
import './styles.css'
import './cashier-cleanup.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <CashierHotkeys />
    <SettingsHub />
    <ShiftCloseGuard />
    <ReceiptExplorer />
    <SaleSuccessOverlay />
    <div className="cashier-hotkey-help">F2 поиск · F4 оплата · Ctrl+1…6 разделы · Esc закрыть</div>
  </StrictMode>
)
