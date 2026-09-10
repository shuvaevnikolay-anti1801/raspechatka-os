import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { PosDatabase } from './database'
import { ConnectionStore } from './connection'
import { registerIpcHandlers } from './ipc'
import { MockFiscalProvider, MockPaymentProvider } from './providers/mock'
import { WindowsPrintProvider } from './providers/print'
import { TransactionJournal } from './transaction-journal'
import { PosTransactionEngine } from './transaction-engine'
import { startAutomaticSync } from './sync'

let stopAutomaticSync:(()=>void)|undefined
let database:PosDatabase|undefined
let journal:TransactionJournal|undefined

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

const hasLock=app.requestSingleInstanceLock()
if(!hasLock){
  app.quit()
}else{
  app.on('second-instance',()=>{
    const window=BrowserWindow.getAllWindows()[0]
    if(window){if(window.isMinimized())window.restore();window.focus()}
  })

  app.whenReady().then(() => {
    const userData=app.getPath('userData')
    database = new PosDatabase(join(userData, 'raspechatka-pos.sqlite'))
    journal = new TransactionJournal(join(userData, 'raspechatka-pos-journal.sqlite'))
    const connectionStore=new ConnectionStore(join(userData, 'connection.bin'))
    const paymentProvider=new MockPaymentProvider()
    const fiscalProvider=new MockFiscalProvider()
    const printProvider=new WindowsPrintProvider(join(userData,'printer-settings.json'))
    const transactionEngine=new PosTransactionEngine(database,journal,paymentProvider,fiscalProvider)

    registerIpcHandlers({database,connectionStore,paymentProvider,fiscalProvider,printProvider,transactionEngine})
    stopAutomaticSync=startAutomaticSync(database,connectionStore)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('before-quit',()=>{
  stopAutomaticSync?.()
  journal?.close()
  database?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
