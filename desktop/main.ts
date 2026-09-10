import { app, dialog, type BrowserWindow } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  confirmQuitAndShutdown,
  createWindow,
  type DesktopWindowHost,
} from './window';
import {
  resolveNodeExecutable,
  resolveServicePaths,
  startService,
  type DesktopService,
  type StartServiceOptions,
} from './service-spawn';

const singleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let windowHost: DesktopWindowHost | null = null;
let service: DesktopService | null = null;
let desktopSecret: string | null = null;
let dataRoot: string | null = null;
let removeIpcHandlers: (() => void) | null = null;
let shutdownPromise: Promise<void> | null = null;
let explicitQuitRequested = false;

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

async function boot(): Promise<void> {
  const projectRoot = resolve(__dirname, '..');
  const paths = resolveServicePaths();
  // Keep packaged data in the documented stable user directory instead of
  // the install bundle or Electron's package-name-derived default.
  dataRoot =
    process.env.CREATIVE_STUDIO_DATA_ROOT ??
    (app.isPackaged ? join(app.getPath('appData'), 'CreativeStudio') : projectRoot);
  desktopSecret = randomBytes(32).toString('hex');
  const launchOptions: StartServiceOptions = {
    ...paths,
    nodePath: resolveNodeExecutable(),
    dataRoot,
    instanceId: randomUUID(),
    desktopSecret,
    // The in-app shutdown button exits the Node service directly. Without this
    // the window would survive as a dead shell pointing at a closed port, so
    // the whole application follows the service down. The quit confirmation is
    // skipped on purpose: the user already confirmed inside the workbench.
    onUnexpectedExit: () => {
      explicitQuitRequested = true;
      void shutdown();
    },
  };

  service = await startService(launchOptions);
  windowHost = {
    origin: service.origin,
    preloadPath: join(__dirname, 'preload.js'),
    service,
    desktopSecret,
    dataRoot,
    isQuitRequested: () => explicitQuitRequested,
    cancelQuitRequest: () => {
      explicitQuitRequested = false;
    },
    setIpcHandlerRemover: (remover) => {
      removeIpcHandlers = remover;
    },
    clearIpcHandlers: () => {
      removeIpcHandlers?.();
      removeIpcHandlers = null;
    },
    onWindowClosed: () => {
      mainWindow = null;
    },
    shutdown: () => shutdown(),
  };
  mainWindow = createWindow(windowHost);
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    removeIpcHandlers?.();
    removeIpcHandlers = null;
    const currentService = service;
    service = null;
    await currentService?.stop();
    desktopSecret = null;
    app.exit(0);
  })();

  return shutdownPromise;
}

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => focusMainWindow());

  app.whenReady().then(boot).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox({
      type: 'error',
      title: '产品素材工作台启动失败',
      message,
    });
    await shutdown();
  });

  app.on('before-quit', (event) => {
    explicitQuitRequested = true;
    if (!shutdownPromise) {
      event.preventDefault();
      void confirmQuitAndShutdown(windowHost, mainWindow, shutdown);
    }
  });

  app.on('window-all-closed', () => {
    // Closing the only window is a hide operation on both supported platforms.
    // The service remains alive until the user explicitly chooses Quit.
  });

  app.on('activate', () => {
    if (!mainWindow && windowHost) {
      // The launch secret remains process-local and is never exposed to the renderer.
      // It is regenerated only on the next application launch, not on window restore.
      mainWindow = createWindow(windowHost);
    } else {
      focusMainWindow();
    }
  });

  // A terminal-launched shell dies on SIGHUP (window closed) or SIGINT (Ctrl+C).
  // The private Node service is detached, so it must be reaped through the same
  // shutdown chain or it outlives Electron and keeps holding SQLite. A signal is
  // not a user decision, so this path skips the quit confirmation dialog.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      explicitQuitRequested = true;
      void shutdown();
    });
  }
}
