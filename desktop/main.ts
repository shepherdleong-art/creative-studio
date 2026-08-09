import { app, BrowserWindow, dialog } from 'electron';
import { accessSync, constants, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { delimiter, join, resolve } from 'node:path';

import { registerIpcHandlers } from './ipc';
import {
  startService,
  type DesktopService,
  type StartServiceOptions,
} from './service';

const singleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let service: DesktopService | null = null;
let removeIpcHandlers: (() => void) | null = null;
let shutdownPromise: Promise<void> | null = null;

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

function exactOrigin(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.hostname === rightUrl.hostname &&
      leftUrl.port === rightUrl.port
    );
  } catch {
    return false;
  }
}

function resolveNodeExecutable(): string {
  const explicitNode = process.env.CREATIVE_STUDIO_NODE;
  if (explicitNode) {
    return explicitNode;
  }

  const npmNode = process.env.npm_node_execpath;
  if (npmNode && npmNode !== process.execPath) {
    return npmNode;
  }

  // Electron's process.execPath is the Electron binary, not a Node runtime.
  // In development, locate the regular Node binary from PATH instead of
  // accidentally launching a second Electron process as the service.
  if (process.versions.electron) {
    const executable = process.platform === 'win32' ? 'node.exe' : 'node';
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (!directory) {
        continue;
      }
      const candidate = join(directory, executable);
      if (candidate === process.execPath || !existsSync(candidate)) {
        continue;
      }
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking through PATH entries.
      }
    }
    throw new Error(
      '找不到私有 Node 运行时，请设置 CREATIVE_STUDIO_NODE 指向 Node 20+ 可执行文件',
    );
  }

  return process.execPath;
}

function resolveServicePaths(): Pick<StartServiceOptions, 'serverRoot' | 'serverEntry'> {
  const projectRoot = resolve(__dirname, '..');
  const standaloneRoot =
    process.env.CREATIVE_STUDIO_STANDALONE_ROOT ??
    join(projectRoot, '.next', 'standalone');
  const bundledEntry = join(standaloneRoot, 'desktop', 'server-entry.js');
  const sourceEntry = join(projectRoot, 'desktop', 'server-entry.js');

  if (existsSync(bundledEntry)) {
    return { serverRoot: standaloneRoot, serverEntry: bundledEntry };
  }
  if (existsSync(sourceEntry)) {
    return { serverRoot: standaloneRoot, serverEntry: sourceEntry };
  }
  throw new Error(
    `找不到 standalone 服务入口，请先执行 npm run build：${bundledEntry}`,
  );
}

function createWindow(currentService: DesktopService): BrowserWindow {
  const preloadPath = join(__dirname, 'preload.js');
  const origin = currentService.origin;
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  let initialNavigationConsumed = false;
  window.webContents.on('will-navigate', (event, url) => {
    if (!initialNavigationConsumed && exactOrigin(url, origin)) {
      initialNavigationConsumed = true;
      return;
    }
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  removeIpcHandlers?.();
  removeIpcHandlers = registerIpcHandlers({
    window,
    origin,
    service: currentService,
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    removeIpcHandlers?.();
    removeIpcHandlers = null;
  });
  void window.loadURL(origin);
  return window;
}

async function boot(): Promise<void> {
  const projectRoot = resolve(__dirname, '..');
  const paths = resolveServicePaths();
  const dataRoot =
    process.env.CREATIVE_STUDIO_DATA_ROOT ??
    (app.isPackaged ? app.getPath('userData') : projectRoot);
  const launchOptions: StartServiceOptions = {
    ...paths,
    nodePath: resolveNodeExecutable(),
    dataRoot,
    instanceId: randomUUID(),
  };

  service = await startService(launchOptions);
  mainWindow = createWindow(service);
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
    if (!shutdownPromise) {
      event.preventDefault();
      void shutdown();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!mainWindow && service) {
      mainWindow = createWindow(service);
    } else {
      focusMainWindow();
    }
  });
}
