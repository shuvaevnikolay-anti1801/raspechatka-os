import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { ConnectionConfig, ConnectionStatus } from '../shared/contracts'

export class ConnectionStore {
  constructor(private readonly filePath: string) {}

  load(): ConnectionConfig | null {
    const fromEnvironment = process.env.RASPECHATKA_API_URL && process.env.RASPECHATKA_API_KEY && process.env.RASPECHATKA_API_SECRET
      ? {
          serverUrl: process.env.RASPECHATKA_API_URL,
          apiKey: process.env.RASPECHATKA_API_KEY,
          apiSecret: process.env.RASPECHATKA_API_SECRET,
          workplaceCode: process.env.RASPECHATKA_WORKPLACE_CODE ?? ''
        } : null
    if (fromEnvironment) return fromEnvironment
    if (!existsSync(this.filePath) || !safeStorage.isEncryptionAvailable()) return null
    try {
      return JSON.parse(safeStorage.decryptString(readFileSync(this.filePath))) as ConnectionConfig
    } catch { return null }
  }

  save(config: ConnectionConfig): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows пока не предоставила защищённое хранилище')
    const normalized = { ...config, serverUrl: config.serverUrl.trim().replace(/\/$/, '') }
    writeFileSync(this.filePath, safeStorage.encryptString(JSON.stringify(normalized)))
  }

  status(lastSyncAt?: string, lastError?: string): ConnectionStatus {
    const config = this.load()
    return {
      configured: Boolean(config),
      serverUrl: config?.serverUrl ?? '',
      workplaceCode: config?.workplaceCode ?? '',
      lastSyncAt,
      lastError
    }
  }
}
