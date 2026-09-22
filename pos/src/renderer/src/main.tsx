import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './AppV2'
import CashierHotkeys from './CashierHotkeys'
import SaleSuccessOverlay from './SaleSuccessOverlay'
import SettingsHub from './SettingsHub'
import ShiftCloseGuard from './ShiftCloseGuard'
import './styles.css'
import './pos-v2.css'
import './sale-workspace.css'
import './pos-design-system.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <CashierHotkeys />
    <SettingsHub />
    <ShiftCloseGuard />
    <SaleSuccessOverlay />
  </StrictMode>
)
