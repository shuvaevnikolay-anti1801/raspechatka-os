import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { PosDatabase } from "./database";
import { PosDatabaseV2 } from "./database-v2";
import { ConnectionStore } from "./connection";
import { registerIpcHandlers } from "./ipc";
import { registerPosV2Ipc } from "./pos-v2-ipc";
import { registerHardwareSettingsIpc } from "./hardware-ipc";
import { WindowsPrintProvider } from "./providers/print";
import { AtolSettingsStore } from "./providers/atol-web";
import { createFiscalProvider } from "./providers/fiscal-provider-factory";
import {
  isAtolBridgeExecutableAvailable,
  NativeAtolDriverBridge,
  resolveAtolBridgeExecutablePath,
} from "./providers/atol-driver-bridge";
import { ShiftCoordinator } from "./shift-coordinator";
import { registerShiftRecoveryIpc } from "./shift-recovery-ipc";
import { registerPilotIpc } from "./pilot-ipc";
import { registerPairingIpc } from "./pairing-ipc";
import { TransactionJournal } from "./transaction-journal";
import { PosTransactionEngine } from "./transaction-engine";
import { CommodityPrintQueue } from "./print-jobs";
import { buildBootState, startAutomaticSync } from "./sync";
import { PosDiagnostics } from "./diagnostics";
import { InpasPaymentProvider } from "./providers/inpas";
import { InpasSettingsStore } from "./providers/inpas-settings";
import { NativeInpasBridge } from "./providers/inpas-direct-bridge";
import { createPaymentProvider } from "./providers/payment-provider-factory";
import { CashierAuthSession } from "./cashier-auth";
import { AtolCredentialStore, AtolWebManager } from "./atol-web-manager";

let stopAutomaticSync: (() => void) | undefined;
let stopAutomaticPrintRetry: (() => void) | undefined;
let database: PosDatabase | undefined;
let journal: TransactionJournal | undefined;
let printQueue: CommodityPrintQueue | undefined;
let diagnostics: PosDiagnostics | undefined;
let atolDriverBridge: NativeAtolDriverBridge | undefined;
let inpasDirectBridge: NativeInpasBridge | undefined;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3f5f1",
    icon: join(__dirname, "../../build/icon.png"),
    title: "Касса Распечатка",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl && new URL(url).origin !== new URL(currentUrl).origin)
      event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    const userData = app.getPath("userData");
    database = new PosDatabaseV2(join(userData, "raspechatka-pos.sqlite"));
    journal = new TransactionJournal(
      join(userData, "raspechatka-pos-journal.sqlite")
    );
    diagnostics = new PosDiagnostics(
      join(userData, "raspechatka-pos-diagnostics.sqlite")
    );
    diagnostics.record({
      source: "app",
      eventType: "app.started",
      message: "Касса Распечатка запущена",
    });
    const connectionStore = new ConnectionStore(
      join(userData, "connection.bin")
    );
    const cashierAuth = new CashierAuthSession(database);
    const trainingMode = process.env.RASPECHATKA_TRAINING_MODE === "1";
    const atolSettingsStore = new AtolSettingsStore(
      join(userData, "atol-settings.json")
    );
    const atolManager = new AtolWebManager(
      new AtolCredentialStore(join(userData, "atol-credentials.bin"))
    );
    const inpasSettingsStore = new InpasSettingsStore(
      join(userData, "inpas-settings.json")
    );
    const inpasResultDirectory = join(userData, "inpas-results");
    const inpasProvider = new InpasPaymentProvider(
      inpasSettingsStore,
      inpasResultDirectory
    );
    const sharedInpasBridge = new NativeInpasBridge({
      executablePath:
        process.env.RASPECHATKA_INPAS_BRIDGE_PATH ?? "Raspechatka.InpasBridge.exe",
    });
    inpasDirectBridge = sharedInpasBridge;
    const paymentProvider = createPaymentProvider({
      trainingMode,
      settingsStore: inpasSettingsStore,
      legacyProvider: inpasProvider,
      directBridge: sharedInpasBridge,
    });
    const atolBridgePath = resolveAtolBridgeExecutablePath({ isPackaged: app.isPackaged });
    atolDriverBridge = trainingMode ? undefined : new NativeAtolDriverBridge({
      executablePath: atolBridgePath,
    });
    if (!trainingMode && !isAtolBridgeExecutableAvailable(atolBridgePath)) {
      diagnostics.record({
        source: "fiscal",
        level: "warning",
        eventType: "atol.driver.missing",
        message: "ATOL bridge helper не найден: прямое подключение не настроено",
        details: { errorCode: "not_configured" },
      });
    }
    const fiscalProvider = createFiscalProvider({
      trainingMode,
      settingsStore: atolSettingsStore,
      webManager: trainingMode ? undefined : atolManager,
      driverBridge: atolDriverBridge,
      currentOperator: () =>
        cashierAuth.state().employee?.name ||
        database?.currentShift()?.cashierName,
      diagnostics,
    });
    const printProvider = new WindowsPrintProvider(
      join(userData, "printer-settings.json")
    );
    const transactionEngine = new PosTransactionEngine(
      database,
      journal,
      paymentProvider,
      fiscalProvider
    );
    const shiftCoordinator = new ShiftCoordinator(database, fiscalProvider);
    printQueue = new CommodityPrintQueue(
      join(userData, "raspechatka-pos-print-jobs.sqlite"),
      database,
      printProvider,
      () => buildBootState(database!)
    );

    try {
      const recovery = await shiftCoordinator.recoverPendingTransition();
      if (recovery.message) {
        database.setState("shift_recovery_message", recovery.message);
        diagnostics.record({
          source: "recovery",
          level: recovery.pending ? "warning" : "info",
          eventType: "shift.recovery",
          message: recovery.message,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      database.setState("shift_recovery_message", message);
      diagnostics.record({
        source: "recovery",
        level: "error",
        eventType: "shift.recovery_failed",
        message,
      });
    }

    try {
      const recovered = await transactionEngine.recoverSafeOperations();
      if (recovered > 0) {
        const message = `После перезапуска безопасно завершено локально: ${recovered}`;
        database.setState("transaction_recovery_message", message);
        diagnostics.record({
          source: "recovery",
          eventType: "transaction.safe_recovery",
          message,
          details: { recovered },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      database.setState("transaction_recovery_message", message);
      diagnostics.record({
        source: "recovery",
        level: "error",
        eventType: "transaction.recovery_failed",
        message,
      });
    }

    registerIpcHandlers({
      database,
      connectionStore,
      paymentProvider,
      fiscalProvider,
      printProvider,
      printQueue,
      transactionEngine,
      shiftCoordinator,
      diagnostics,
      cashierAuth,
    });
    registerPosV2Ipc(connectionStore);
    registerShiftRecoveryIpc({
      database,
      fiscalProvider,
      shiftCoordinator,
      diagnostics,
    });
    registerPilotIpc(diagnostics);
    registerPairingIpc({ diagnostics, cashierAuth });
    registerHardwareSettingsIpc(
      atolSettingsStore,
      trainingMode ? undefined : atolManager,
      trainingMode ? undefined : fiscalProvider,
      inpasSettingsStore,
      trainingMode ? undefined : inpasProvider,
      diagnostics,
      atolDriverBridge,
      () => journal!.hasBlockingFiscalOperation(),
      inpasDirectBridge,
      () => transactionEngine.hasBlockingOperation(),
      inpasResultDirectory
    );
    if (!trainingMode && atolSettingsStore.load().enabled && atolSettingsStore.load().adapter === "web")
      void atolManager
        .ensureReady()
        .catch((error) =>
          diagnostics?.record({
            source: "fiscal",
            level: "error",
            eventType: "atol.start_failed",
            message: error instanceof Error ? error.message : String(error),
          })
        );
    stopAutomaticSync = startAutomaticSync(
      database,
      connectionStore,
      () => cashierAuth.state().employee?.id
    );
    stopAutomaticPrintRetry = printQueue.startAutomaticRetry();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  try {
    diagnostics?.record({
      source: "app",
      eventType: "app.stopping",
      message: "Касса Распечатка завершает работу",
    });
  } catch {}
  stopAutomaticSync?.();
  stopAutomaticPrintRetry?.();
  printQueue?.close();
  void atolDriverBridge?.stop();
  void inpasDirectBridge?.stop();
  journal?.close();
  database?.close();
  diagnostics?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
