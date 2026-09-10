import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import PosSafetyPanel from './PosSafetyPanel'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <PosSafetyPanel />
  </StrictMode>
)
