import { app, dialog, type BrowserWindow } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
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
import { CHANNELS } from './ipc';

// 实验运行身份独立于产品归属；必须在申请单实例锁之前设置。
app.setName('Creative Studio Canvas');
app.setPath('userData', join(app.getPath('appData'), 'CreativeStudioCanvas'));
app.setAppUserModelId('local.creative-studio.canvas');
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
    (app.isPackaged ? join(app.getPath('appData'), 'CreativeStudioCanvas') : projectRoot);
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
    event.preventDefault();
    if (explicitQuitRequested || shutdownPromise) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // The X and menu Quit open the same in-page dialog as the power button.
      // Only its confirmation sends /api/shutdown; cancellation leaves the
      // service and IPC handlers untouched.
      focusMainWindow();
      mainWindow.webContents.send(CHANNELS.quitRequested);
    } else {
      explicitQuitRequested = true;
      void shutdown();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
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
