import { app, dialog, shell, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

import { CHANNELS, registerIpcHandlers, sameOrigin, type DesktopIpcHandlers } from './ipc';
import type { DesktopService } from './service-spawn';
import { applyThemePreference } from './theme';

const LINKED_MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.webm']);
const MAX_LINKED_IMPORT_FILES = 500;

let closeNoticeShown = false;

interface LinkedImportResponse {
  assetIds: string[];
  errors: Array<{ index: number; message: string }>;
}

interface RelocateLinkedSourceResponse {
  relocated: boolean;
}

// Everything the window needs from the shell process. Window creation and the
// quit confirmation live here; the shell owns service/secret/dataRoot state
// and hands it over as a snapshot plus callbacks, so this module never
// reaches back into main.ts.
export interface DesktopWindowHost {
  readonly origin: string;
  readonly preloadPath: string;
  readonly service: DesktopService;
  readonly desktopSecret: string;
  readonly dataRoot: string;
  isQuitRequested(): boolean;
  cancelQuitRequest(): void;
  setIpcHandlerRemover(remover: (() => void) | null): void;
  clearIpcHandlers(): void;
  onWindowClosed(): void;
  shutdown(): Promise<void>;
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
  host: DesktopWindowHost,
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
      return postLinkedFiles(window, host.service, host.desktopSecret, selection.filePaths);
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
      return postLinkedFiles(window, host.service, host.desktopSecret, filePaths);
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
        host.service,
        host.desktopSecret,
        assetId,
        sourceId,
        filePath,
      );
    },
    getAppVersion: () => app.getVersion(),
    openFolder: async (relativePath) => {
      // 只接受工作台存储目录内的相对路径：拒绝绝对路径、`..` 段与非 storage 前缀，
      // resolve 之后再做一次 containment 断言兜底。
      if (
        typeof relativePath !== 'string'
        || relativePath.length === 0
        || isAbsolute(relativePath)
        || relativePath.split(/[\\/]+/).includes('..')
        || !(relativePath === 'storage' || relativePath.startsWith('storage/') || relativePath.startsWith('storage\\'))
      ) {
        throw new Error('只允许打开工作台存储目录内的文件夹');
      }
      const absolute = resolve(host.dataRoot, relativePath);
      const contained = relative(host.dataRoot, absolute);
      if (contained === '' || contained.startsWith('..') || isAbsolute(contained)) {
        throw new Error('只允许打开工作台存储目录内的文件夹');
      }
      const failure = await shell.openPath(absolute);
      return failure ? { opened: false, message: failure } : { opened: true };
    },
    setThemePreference: (preference) => {
      applyThemePreference(preference);
    },
  };
}

function installIpcHandlers(window: BrowserWindow, host: DesktopWindowHost): void {
  const removeHandlers = registerIpcHandlers({
    window,
    origin: host.origin,
    handlers: createDesktopIpcHandlers(window, host),
  });
  host.setIpcHandlerRemover(removeHandlers);
}

export function createWindow(host: DesktopWindowHost): BrowserWindow {
  const origin = host.origin;
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    webPreferences: {
      preload: host.preloadPath,
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
    if (host.isQuitRequested()) return;
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

  installIpcHandlers(window, host);

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    host.onWindowClosed();
    host.clearIpcHandlers();
  });
  void window.loadURL(host.origin);
  return window;
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

export async function confirmQuitAndShutdown(
  host: DesktopWindowHost | null,
  window: BrowserWindow | null,
  shutdown: () => Promise<void>,
): Promise<void> {
  // Freeze new desktop operations while the quit decision and shutdown
  // orchestration are in flight. If the user cancels, restore the same
  // handlers against the still-running window and service.
  host?.clearIpcHandlers();
  const active = host
    ? await activeWorkState(host.service, host.desktopSecret)
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
    const result = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 0) {
      host?.cancelQuitRequest();
      if (host && window && !window.isDestroyed()) {
        installIpcHandlers(window, host);
      }
      return;
    }
  }
  await shutdown();
}
