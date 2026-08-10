import { app, BrowserWindow, dialog } from 'electron';
import { accessSync, constants, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { delimiter, extname, join, resolve } from 'node:path';

import { CHANNELS, registerIpcHandlers, sameOrigin, type DesktopIpcHandlers } from './ipc';
import {
  startService,
  type DesktopService,
  type StartServiceOptions,
} from './service';

const singleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let service: DesktopService | null = null;
let desktopSecret: string | null = null;
let removeIpcHandlers: (() => void) | null = null;
let shutdownPromise: Promise<void> | null = null;
let explicitQuitRequested = false;
let closeNoticeShown = false;

const LINKED_MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.webm']);
const MAX_LINKED_IMPORT_FILES = 500;

interface LinkedImportResponse {
  assetIds: string[];
  errors: Array<{ index: number; message: string }>;
}

interface RelocateLinkedSourceResponse {
  relocated: boolean;
}

function isLinkedImportResponse(value: unknown): value is LinkedImportResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.assetIds)
    && candidate.assetIds.every((assetId) => typeof assetId === 'string')
    && Array.isArray(candidate.errors);
}

function isRelocateLinkedSourceResponse(value: unknown): value is RelocateLinkedSourceResponse {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { relocated?: unknown }).relocated === 'boolean',
  );
}

function currentProjectId(window: BrowserWindow): string {
  try {
    const pathname = new URL(window.webContents.getURL()).pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] === 'projects' && segments[1]) {
      return decodeURIComponent(segments[1]);
    }
  } catch {
    // Treat a missing or malformed renderer URL as an unavailable project context.
  }
  throw new Error('请先在工作台中打开一个项目');
}

async function collectFolderMediaFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (currentDirectory: string): Promise<void> => {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && LINKED_MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(absolutePath);
        if (files.length > MAX_LINKED_IMPORT_FILES) return;
      }
    }
  };
  await walk(resolve(directory));
  if (files.length > MAX_LINKED_IMPORT_FILES) {
    throw new Error(`文件夹内视频超过 ${MAX_LINKED_IMPORT_FILES} 条，请分批选择`);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function postLinkedFiles(
  window: BrowserWindow,
  currentService: DesktopService,
  desktopSecret: string,
  filePaths: string[],
): Promise<{ requestId: string; count: number }> {
  const projectId = currentProjectId(window);
  const requestId = randomUUID();
  let count = 0;
  for (let index = 0; index < filePaths.length; index += 1) {
    const response = await fetch(`${currentService.origin}/api/desktop/import-linked`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-creative-studio-desktop-secret': desktopSecret,
      },
      // Keep the HTTP contract unchanged; one selected path is sent per
      // request so the renderer can show honest N/M progress.
      body: JSON.stringify({ projectId, filePaths: [filePaths[index]] }),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`原片登记失败（HTTP ${response.status}）`);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!isLinkedImportResponse(payload)) {
      throw new Error('原片登记服务返回了无效结果');
    }
    count += payload.assetIds.length;
    if (!window.isDestroyed()) {
      window.webContents.send(CHANNELS.linkedImportProgress, {
        requestId,
        completed: index + 1,
        total: filePaths.length,
      });
    }
  }
  return { requestId, count };
}

async function postRelocatedSource(
  window: BrowserWindow,
  currentService: DesktopService,
  desktopSecret: string,
  assetId: string,
  sourceId: string,
  filePath: string,
): Promise<RelocateLinkedSourceResponse> {
  const projectId = currentProjectId(window);
  const response = await fetch(`${currentService.origin}/api/desktop/relocate-linked`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-creative-studio-desktop-secret': desktopSecret,
    },
    body: JSON.stringify({ projectId, assetId, sourceId, filePath }),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`原片重新定位失败（HTTP ${response.status}）`);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!isRelocateLinkedSourceResponse(payload)) {
    throw new Error('原片重新定位服务返回了无效结果');
  }
  return payload;
}

function createDesktopIpcHandlers(
  window: BrowserWindow,
  currentService: DesktopService,
  desktopSecret: string,
): DesktopIpcHandlers {
  return {
    platform: () => {
      if (process.platform === 'darwin') {
        return 'macos';
      }
      if (process.platform === 'win32') {
        return 'windows';
      }
      throw new Error(`不支持的桌面平台：${process.platform}`);
    },
    chooseMediaFiles: async () => {
      const selection = await dialog.showOpenDialog(window, {
        title: '选择本机原片',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'avi', 'webm'] }],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { requestId: randomUUID(), count: 0 };
      }
      return postLinkedFiles(window, currentService, desktopSecret, selection.filePaths);
    },
    chooseFolder: async () => {
      const selection = await dialog.showOpenDialog(window, {
        title: '选择原片文件夹',
        properties: ['openDirectory'],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return null;
      }
      let filePaths: string[];
      try {
        filePaths = await collectFolderMediaFiles(selection.filePaths[0]);
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith('文件夹内视频超过')) {
          throw error;
        }
        throw new Error('无法读取所选文件夹');
      }
      if (filePaths.length === 0) {
        return { requestId: randomUUID(), count: 0 };
      }
      return postLinkedFiles(window, currentService, desktopSecret, filePaths);
    },
    relocateLinkedSource: async (assetId, sourceId) => {
      const selection = await dialog.showOpenDialog(window, {
        title: '重新定位原片',
        properties: ['openFile'],
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'avi', 'webm'] }],
      });
      const filePath = selection.filePaths[0];
      if (selection.canceled || !filePath) {
        return { relocated: false };
      }
      return postRelocatedSource(
        window,
        currentService,
        desktopSecret,
        assetId,
        sourceId,
        filePath,
      );
    },
    getAppVersion: () => app.getVersion(),
  };
}

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

async function activeWorkState(
  currentService: DesktopService,
  currentSecret: string,
): Promise<boolean | null> {
  try {
    const response = await fetch(`${currentService.origin}/api/desktop/activity`, {
      method: 'GET',
      headers: { 'x-creative-studio-desktop-secret': currentSecret },
      redirect: 'error',
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || typeof (payload as { active?: unknown }).active !== 'boolean') {
      return null;
    }
    return (payload as { active: boolean }).active;
  } catch {
    return null;
  }
}

async function confirmQuitAndShutdown(): Promise<void> {
  const currentService = service;
  const currentSecret = desktopSecret;
  // Freeze new desktop operations while the quit decision and shutdown
  // orchestration are in flight. If the user cancels, restore the same
  // handlers against the still-running window and service.
  const currentWindow = mainWindow;
  removeIpcHandlers?.();
  removeIpcHandlers = null;
  const active = currentService && currentSecret
    ? await activeWorkState(currentService, currentSecret)
    : null;
  if (active !== false) {
    const options = {
      type: 'warning' as const,
      title: '确认退出产品素材工作台',
      message: active === true
        ? '当前仍有任务在后台运行。退出会停止当前运行，已持久化的任务可在下次启动后恢复。'
        : '无法确认任务状态。若仍有任务，退出后会由持久化状态在下次启动时恢复。',
      buttons: ['暂停任务并退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 0) {
      explicitQuitRequested = false;
      if (currentWindow && !currentWindow.isDestroyed() && currentService && currentSecret) {
        removeIpcHandlers = registerIpcHandlers({
          window: currentWindow,
          origin: currentService.origin,
          handlers: createDesktopIpcHandlers(currentWindow, currentService, currentSecret),
        });
      }
      return;
    }
  }
  await shutdown();
}

function resolveNodeExecutable(): string {
  const explicitNode = process.env.CREATIVE_STUDIO_NODE;
  if (explicitNode) {
    return explicitNode;
  }

  if (app.isPackaged) {
    const bundledNode = join(
      process.resourcesPath,
      'app',
      'runtime',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    if (existsSync(bundledNode)) {
      return bundledNode;
    }
    throw new Error(`安装包缺少私有 Node 运行时：${bundledNode}`);
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
  const bundledEntry = join(standaloneRoot, 'runtime', 'server-entry.js');
  const sourceEntry = join(projectRoot, 'runtime', 'server-entry.js');

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

function installIpcHandlers(
  window: BrowserWindow,
  currentService: DesktopService,
  currentSecret: string,
): void {
  removeIpcHandlers?.();
  removeIpcHandlers = registerIpcHandlers({
    window,
    origin: currentService.origin,
    handlers: createDesktopIpcHandlers(window, currentService, currentSecret),
  });
}

function createWindow(currentService: DesktopService, desktopSecret: string): BrowserWindow {
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
      webviewTag: false,
    },
  });

  // Electron's programmatic loadURL() does not emit will-navigate. Therefore
  // the initial load needs no exception here; same-origin renderer navigation
  // is allowed while cross-origin navigation remains blocked.
  window.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, origin)) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler((details) => {
    if (sameOrigin(details.url, origin)) {
      window.webContents.downloadURL(details.url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  window.on('close', (event) => {
    if (explicitQuitRequested) return;
    event.preventDefault();
    window.hide();
    if (closeNoticeShown) return;
    closeNoticeShown = true;
    void dialog.showMessageBox({
      type: 'info',
      title: '产品素材工作台仍在运行',
      message: '窗口已隐藏，后台任务会继续运行。点击程序图标可恢复窗口；请使用“退出”结束任务并关闭服务。',
    });
  });

  installIpcHandlers(window, currentService, desktopSecret);

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
  // Keep packaged data in the documented stable user directory instead of
  // the install bundle or Electron's package-name-derived default.
  const dataRoot =
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
  mainWindow = createWindow(service, desktopSecret);
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
      void confirmQuitAndShutdown();
    }
  });

  app.on('window-all-closed', () => {
    // Closing the only window is a hide operation on both supported platforms.
    // The service remains alive until the user explicitly chooses Quit.
  });

  app.on('activate', () => {
    if (!mainWindow && service && desktopSecret) {
      // The launch secret remains process-local and is never exposed to the renderer.
      // It is regenerated only on the next application launch, not on window restore.
      mainWindow = createWindow(service, desktopSecret);
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
