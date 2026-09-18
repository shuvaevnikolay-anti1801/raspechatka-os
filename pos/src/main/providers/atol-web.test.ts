import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AtolWebManager } from '../atol-web-manager'
import { AtolSettingsStore, AtolWebFiscalProvider, allocateFiscalAmounts } from './atol-web'

const enabledSettings = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:16732/api/v2',
  taxationType: 'patent',
  taxType: 'none'
}

function settingsStore(): AtolSettingsStore {
  return { load: () => ({ ...enabledSettings }) } as AtolSettingsStore
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('allocateFiscalAmounts',()=>{
  it('keeps fiscal positions equal to discounted receipt total',()=>{
    const amounts=allocateFiscalAmounts([
      {productId:'a',name:'A',quantity:1,unitPriceMinor:10000,discountPercent:0},
      {productId:'b',name:'B',quantity:2,unitPriceMinor:5000,discountPercent:0}
    ],18000)
    expect(amounts.reduce((sum,value)=>sum+value,0)).toBe(18000)
    expect(amounts).toEqual([9000,9000])
  })

  it('absorbs rounding into the last position without changing receipt total',()=>{
    const amounts=allocateFiscalAmounts([
      {productId:'a',name:'A',quantity:1,unitPriceMinor:100,discountPercent:0},
      {productId:'b',name:'B',quantity:1,unitPriceMinor:100,discountPercent:0},
      {productId:'c',name:'C',quantity:1,unitPriceMinor:100,discountPercent:0}
    ],100)
    expect(amounts).toEqual([33,33,34])
    expect(amounts.reduce((sum,value)=>sum+value,0)).toBe(100)
  })
})

describe('AtolWebFiscalProvider', () => {
  it('rotates the service credentials once on HTTP 401 and retries with the new Authorization header', async () => {
    let authorization = 'Basic old-credentials'
    const recoverAuthorization = vi.fn(async () => {
      authorization = 'Basic new-credentials'
    })
    const manager = {
      ensureReady: vi.fn(async () => ({ ready: true, message: 'ok' })),
      authorizationHeader: vi.fn(() => authorization),
      recoverAuthorization
    } as unknown as AtolWebManager

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 505, description: 'unauthorized' } }, 401))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ error: { code: 0 }, result: { shiftStatus: { state: 'closed' } } }]
      }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new AtolWebFiscalProvider(settingsStore(), manager)
    const shift = await provider.getShiftStatus()

    expect(shift.state).toBe('closed')
    expect(recoverAuthorization).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const firstHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers as HeadersInit)
    const retryHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers as HeadersInit)
    const pollHeaders = new Headers(fetchMock.mock.calls[2][1]?.headers as HeadersInit)
    expect(firstHeaders.get('Authorization')).toBe('Basic old-credentials')
    expect(retryHeaders.get('Authorization')).toBe('Basic new-credentials')
    expect(pollHeaders.get('Authorization')).toBe('Basic new-credentials')
  })

  it('uses the explicitly preserved cashier when a fiscal shift is recovered', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ results: [{ error: { code: 0 }, result: {} }] }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new AtolWebFiscalProvider(settingsStore(), undefined, () => 'Другой кассир')
    await provider.closeShift('Мария Иванова')

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      request: Array<{ operator?: { name?: string } }>
    }
    expect(body.request[0].operator).toEqual({ name: 'Мария Иванова' })
  })

  it('puts the current signed-in cashier into a fiscal receipt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({
        results: [{
          error: { code: 0 },
          result: { fiscalParams: { fiscalDocumentNumber: '12345' } }
        }]
      }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new AtolWebFiscalProvider(settingsStore(), undefined, () => 'Анна Петрова')
    await provider.fiscalizeSale({
      operationId: 'operation-1',
      saleId: 'sale-1',
      amountMinor: 10000,
      payments: [{ method: 'cash', amountMinor: 10000 }],
      lines: [{ productId: 'product-1', name: 'Печать', quantity: 1, unitPriceMinor: 10000, discountPercent: 0 }]
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      request: Array<{ operator?: { name?: string } }>
    }
    expect(body.request[0].operator).toEqual({ name: 'Анна Петрова' })
  })
})
