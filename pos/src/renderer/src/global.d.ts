import type { PosApi } from '../../shared/contracts'

declare global {
  interface Window {
    raspechatkaPos: PosApi
  }
}

export {}
