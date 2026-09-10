import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { ConnectionConfig, ConnectionStatus } from '../shared/contracts'

export class ConnectionStore {
  constructor(private readonly filePath: string) {}

  load(): ConnectionConfig | null {
    const fromEnvironment = process.env.RASPECHATKA_API_URL && process.env.RASPECHATKA_DEVICE_ID && process.env.RASPECHATKA_DEVICE_TOKEN
      ? {
          serverUrl: process.env.RASPECHATKA_API_URL,
          deviceId: process.env.RASPECHATKA_DEVICE_ID,
          token: process.env.RASPECHATKA_DEVICE_TOKEN,
          cashierId: process.env.RASPECHATKA_CASHIER_ID || undefined
        } : null
    if (fromEnvironment) return fromEnvironment
    if (!existsSync(this.filePath) || !safeStorage.isEncryptionAvailable()) return null
    try {
      const value=JSON.parse(safeStorage.decryptString(readFileSync(this.filePath))) as Partial<ConnectionConfig>
      if(!value.serverUrl||!value.deviceId||!value.token)return null
      return {serverUrl:value.serverUrl,deviceId:value.deviceId,token:value.token,cashierId:value.cashierId}
    } catch { return null }
  }

  save(config: ConnectionConfig): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows пока не предоставила защищённое хранилище')
    const normalized:ConnectionConfig = {
      serverUrl: config.serverUrl.trim().replace(/\/$/, ''),
      deviceId: config.deviceId.trim(),
      token: config.token.trim(),
      cashierId: config.cashierId?.trim()||undefined
    }
    if(!/^https?:\/\//i.test(normalized.serverUrl))throw new Error('Укажите корректный адрес Распечатка OS')
    if(!normalized.deviceId)throw new Error('Введите Device ID из раздела «Подключение кассы»')
    if(!normalized.token)throw new Error('Введите Token из раздела «Подключение кассы»')
    writeFileSync(this.filePath, safeStorage.encryptString(JSON.stringify(normalized)))
  }

  setCashier(cashierId:string):void{
    const config=this.load();if(!config)throw new Error('Сначала подключите кассу к Распечатка OS')
    this.save({...config,cashierId:cashierId.trim()||undefined})
  }

  status(lastSyncAt?: string, lastError?: string): ConnectionStatus {
    const config = this.load()
    return {
      configured: Boolean(config),
      serverUrl: config?.serverUrl ?? '',
      deviceId: config?.deviceId,
      cashierId: config?.cashierId,
      lastSyncAt,
      lastError
    }
  }
}
