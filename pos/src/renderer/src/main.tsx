import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import DiagnosticsList from './DiagnosticsList'
import PosSafetyPanel from './PosSafetyPanel'
import ShiftRecoveryBanner from './ShiftRecoveryBanner'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ShiftRecoveryBanner />
    <PosSafetyPanel />
    <DiagnosticsList />
  </StrictMode>
)
