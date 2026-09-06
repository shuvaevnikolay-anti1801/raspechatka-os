import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { PosDatabase } from './database'
import { ConnectionStore } from './connection'
import { registerIpcHandlers } from './ipc'
import { MockFiscalProvider, MockPaymentProvider } from './providers/mock'
import { WindowsPrintProvider } from './providers/print'

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f5f1',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const currentUrl = window.webContents.getURL()
    if (currentUrl && new URL(url).origin !== new URL(currentUrl).origin) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const database = new PosDatabase(join(app.getPath('userData'), 'raspechatka-pos.sqlite'))
  registerIpcHandlers({
    database,
    connectionStore: new ConnectionStore(join(app.getPath('userData'), 'connection.bin')),
    paymentProvider: new MockPaymentProvider(),
    fiscalProvider: new MockFiscalProvider(),
    printProvider: new WindowsPrintProvider()
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
