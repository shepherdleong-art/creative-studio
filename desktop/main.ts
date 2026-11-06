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
import { completeFilmNavigation, consumeFilmNavigationRequest } from './reassembled-navigation';
import { createRemoteClientHost, confirmRemoteClientHealth, defaultClientStateRoot, readRemoteClientConfig } from './client/remote-host';
import { spawnIndependentUpdateHelper } from './client/update-helper';

if (process.env.CREATIVE_STUDIO_CLIENT_MODE === 'remote') {
  const remoteStateRoot = defaultClientStateRoot();
  app.setPath('userData', join(remoteStateRoot, 'electron'));
}
const singleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let windowHost: DesktopWindowHost | null = null;
let service: DesktopService | null = null;
let desktopSecret: string | null = null;
let dataRoot: string | null = null;
let removeIpcHandlers: (() => void) | null = null;
let shutdownPromise: Promise<void> | null = null;
let explicitQuitRequested = false;
let filmNavigationTimer: ReturnType<typeof setInterval> | null = null;

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
  const clientConfig = readRemoteClientConfig();
  if (clientConfig.mode === 'remote') {
    const remoteStateRoot = defaultClientStateRoot();
    const installRoot = process.env.CREATIVE_STUDIO_CLIENT_INSTALL_ROOT;
    windowHost = await createRemoteClientHost({
      origin: clientConfig.origin,
      stateRoot: remoteStateRoot,
      preloadPath: join(__dirname, 'preload.js'),
      isQuitRequested: () => explicitQuitRequested,
      setIpcHandlerRemover: (remover) => { removeIpcHandlers = remover; },
      clearIpcHandlers: () => {
        removeIpcHandlers?.();
        removeIpcHandlers = null;
      },
      onWindowClosed: () => { mainWindow = null; },
      shutdown: () => shutdown(),
      installUpdate: async (manifestUrl) => {
        if (!installRoot) return { started: false, message: '未找到稳定安装根，请使用受控修复包。' };
        await spawnIndependentUpdateHelper({
          installRoot,
          manifestUrl,
          serverOrigin: clientConfig.origin,
          currentPid: process.pid,
          onPauseRequested: async () => {
            if (windowHost?.mode === 'remote') await windowHost.remote.pauseForUpdate();
          },
          onResumeRequested: async () => {
            if (windowHost?.mode === 'remote') await windowHost.remote.resumeAfterUpdate();
          },
          onStopRequested: async () => {
            explicitQuitRequested = true;
            await shutdown();
          },
          onResult: (result) => {
            if ((result.status === 'rejected' || result.status === 'recovery_required') && !shutdownPromise) {
              void dialog.showMessageBox({
                type: 'error', title: '轻客户端更新未完成',
                message: result.message ?? '已保留当前版本与本机状态，请重试或联系管理员修复。',
              });
            }
          },
        });
        return { started: true };
      },
    });
    mainWindow = createWindow(windowHost);
    await confirmRemoteClientHealth(remoteStateRoot, windowHost.remote);
    return;
  }
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
    environment: { CREATIVE_STUDIO_APPLICATION_ROOT: projectRoot, CREATIVE_STUDIO_DESKTOP_USER_DATA: app.getPath('userData') },
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
    mode: 'local',
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
  filmNavigationTimer = setInterval(() => {
    if (!service || !dataRoot || !mainWindow || mainWindow.isDestroyed()) return;
    const destination = consumeFilmNavigationRequest(dataRoot, service.instanceId);
    if (destination) {
      const root = dataRoot, instance = service.instanceId;
      focusMainWindow();
      void mainWindow.loadURL(new URL(destination.url, service.origin).href)
        .then(() => completeFilmNavigation(root, instance, destination, true), () => completeFilmNavigation(root, instance, destination, false))
        .catch(() => { /* A closed data directory cannot acknowledge navigation. */ });
    }
  }, 500);
  filmNavigationTimer.unref();
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    if (filmNavigationTimer) clearInterval(filmNavigationTimer);
    removeIpcHandlers?.();
    removeIpcHandlers = null;
    const currentService = service;
    service = null;
    if (windowHost?.mode === 'remote') {
      await windowHost.remote.stop();
      await Promise.race([
        windowHost.session.flushStorageData(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]).catch(() => undefined);
    }
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
    if (windowHost?.mode === 'remote') {
      explicitQuitRequested = true;
      void shutdown();
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      // The local X and menu Quit open the same in-page dialog as the power button.
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
