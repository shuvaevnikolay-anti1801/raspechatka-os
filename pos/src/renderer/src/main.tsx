import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './AppV2'
import CashierHotkeys from './CashierHotkeys'
import ReceiptFiltersBridge from './ReceiptFiltersBridge'
import SaleSuccessOverlay from './SaleSuccessOverlay'
import SettingsHub from './SettingsHub'
import ShiftCloseGuard from './ShiftCloseGuard'
import './styles.css'
import './cashier-cleanup.css'
import './pos-v2.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ReceiptFiltersBridge />
    <CashierHotkeys />
    <SettingsHub />
    <ShiftCloseGuard />
    <SaleSuccessOverlay />
  </StrictMode>
)
