import { app, dialog, shell, BrowserWindow, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

import { CHANNELS, registerIpcHandlers, sameOrigin, type DesktopIpcHandlers } from './ipc';
import type { ClientStatus, RemoteUploadTarget, ClientDiagnosticInput } from './bridge-types';
import type { DesktopService } from './service-spawn';
import { applyThemePreference } from './theme';

const LINKED_MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.webm']);
const MAX_LINKED_IMPORT_FILES = 500;

// ── 启动画面 ──────────────────────────────────────────────────────────────
// 桌面运行壳在连上服务前显示一份完全本地的页面：标志、端名、连接状态。
// 连不上时写明原因并给一个重试按钮；跟随外观偏好浅/深；零外链，不依赖
// 服务器上的任何资源。文案与 lib/brand.ts 的一致性由
// scripts/brand-identity-guard.test.ts 守护（壳里不能 import lib/）。
export const SPLASH_BRAND = "林视 Lin's Vision";
export const SPLASH_SUBTITLE = 'AI 产品图与短视频创作工作台';
export const SPLASH_CONNECTING_TEXT = '正在连接服务器';
export const SPLASH_FAILED_TEXT = '连接服务器失败';
export const SPLASH_RETRY_LABEL = '重试';
/**
 * 重试信号走页内锚点跳转：主进程监听 `did-navigate-in-page`，页面本身不需要
 * 任何特权脚本，也不新增 IPC 通道或改动 preload 暴露面。
 */
export const SPLASH_RETRY_HASH = '#lins-retry';

const SPLASH_MARK_SVG = `<svg class="mark" viewBox="0 0 100 100" width="72" height="72" aria-hidden="true" focusable="false">
  <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#46A97B"/><stop offset="1" stop-color="#1D6A4B"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="96" height="96" rx="22" fill="url(#mg)"/>
  <rect x="2.5" y="2.5" width="95" height="95" rx="21.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.22"/>
  <g transform="rotate(-45 50 50)">
    <path fill="#FFFFFF" fill-rule="evenodd" d="M12 50C28 20 72 20 88 50 72 80 28 80 12 50zM50 39a11 11 0 100 22 11 11 0 000-22z"/>
  </g>
</svg>`;

const SPLASH_STYLES = `
  :root {
    color-scheme: light dark;
    --splash-bg: #E9E9EE; --splash-card: #FFFFFF; --splash-ink: #1D1D1F;
    --splash-secondary: #5F5F64; --splash-hairline: rgba(0,0,0,.09);
    --splash-accent: #0071E3; --splash-dot: #FF9F0A; --splash-dot-fail: #FF3B30;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --splash-bg: #0E0E10; --splash-card: #1E1E20; --splash-ink: #F5F5F7;
      --splash-secondary: #AEAEB3; --splash-hairline: rgba(255,255,255,.11);
      --splash-accent: #0A72E0; --splash-dot: #FFD60A; --splash-dot-fail: #FF6961;
    }
  }
  html[data-theme='light'] {
    --splash-bg: #E9E9EE; --splash-card: #FFFFFF; --splash-ink: #1D1D1F;
    --splash-secondary: #5F5F64; --splash-hairline: rgba(0,0,0,.09);
    --splash-accent: #0071E3; --splash-dot: #FF9F0A; --splash-dot-fail: #FF3B30;
  }
  html[data-theme='dark'] {
    --splash-bg: #0E0E10; --splash-card: #1E1E20; --splash-ink: #F5F5F7;
    --splash-secondary: #AEAEB3; --splash-hairline: rgba(255,255,255,.11);
    --splash-accent: #0A72E0; --splash-dot: #FFD60A; --splash-dot-fail: #FF6961;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: var(--splash-bg); color: var(--splash-ink);
    font: 400 13.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased; user-select: none; cursor: default;
  }
  .card {
    width: 372px; max-width: calc(100vw - 48px); padding: 28px 26px 24px;
    background: var(--splash-card); border-radius: 22px; text-align: center;
    box-shadow: 0 0 0 0.5px var(--splash-hairline), 0 24px 70px rgba(0,0,0,.18);
  }
  .mark { display: block; margin: 0 auto 12px; }
  h1 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: .01em; }
  .subtitle { margin: 6px 0 0; font-size: 12.5px; color: var(--splash-secondary); }
  .status { display: inline-flex; align-items: center; gap: 8px; margin-top: 22px; font-size: 13.5px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--splash-dot); }
  .dot.failed { background: var(--splash-dot-fail); }
  .connecting .dot { animation: splash-pulse 1.1s ease-in-out infinite; }
  @keyframes splash-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .reason {
    margin: 14px 0 0; padding: 10px 12px; border-radius: 10px; text-align: left;
    background: color-mix(in srgb, var(--splash-dot-fail) 12%, transparent);
    color: var(--splash-secondary); font-size: 12.5px; line-height: 1.6;
    word-break: break-word; white-space: pre-wrap; max-height: 148px; overflow: auto;
  }
  .retry {
    display: inline-flex; align-items: center; justify-content: center;
    margin-top: 16px; padding: 9px 28px; border-radius: 10px; border: 0;
    background: var(--splash-accent); color: #fff; font-size: 13.5px; font-weight: 500;
    text-decoration: none; cursor: default;
  }
  .retry:focus-visible { outline: 2px solid var(--splash-accent); outline-offset: 2px; }
  .hint { margin: 14px 0 0; font-size: 12px; color: var(--splash-secondary); }
  @media (prefers-reduced-motion: reduce) { .connecting .dot { animation: none; } }
`;

export type SplashPhase = 'connecting' | 'failed';

export interface SplashState {
  phase: SplashPhase;
  /** 失败原因；connecting 时忽略。 */
  reason?: string;
}

function escapeSplashHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把失败原因整理成启动画面上可读的一段文字（去掉过长的 stderr 尾巴）。 */
export function splashFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 8) return lines.join('\n');
  return [...lines.slice(0, 3), `……（已省略 ${lines.length - 6} 行日志）`, ...lines.slice(-3)].join('\n');
}

/**
 * 启动画面的完整 HTML。`theme` 缺省时交给 CSS 的 prefers-color-scheme 决定，
 * 与页面内三态外观（跟随系统）一致。
 */
export function renderSplashHtml(state: SplashState, theme?: 'light' | 'dark'): string {
  const failed = state.phase === 'failed';
  const themeAttribute = theme ? ` data-theme="${theme}"` : '';
  const statusText = failed ? SPLASH_FAILED_TEXT : SPLASH_CONNECTING_TEXT;
  const reason = failed
    ? `<p class="reason" role="alert">${escapeSplashHtml(state.reason?.trim() || '未收到服务器的连接应答。')}</p>
       <a class="retry" id="splash-retry" href="${SPLASH_RETRY_HASH}">${SPLASH_RETRY_LABEL}</a>
       <p class="hint">服务器仍在启动时，稍候再重试即可。</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"${themeAttribute}>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>${escapeSplashHtml(SPLASH_BRAND)}</title>
<style>${SPLASH_STYLES}</style>
</head>
<body>
  <div class="card">
    ${SPLASH_MARK_SVG}
    <h1>${escapeSplashHtml(SPLASH_BRAND)}</h1>
    <p class="subtitle">${escapeSplashHtml(SPLASH_SUBTITLE)}</p>
    <div class="status ${failed ? 'failed' : 'connecting'}"><span class="dot${failed ? ' failed' : ''}"></span><span>${statusText}</span></div>
    ${reason}
  </div>
</body>
</html>`;
}

/** 判断一次页内跳转是否就是「重试」信号。 */
export function isSplashRetryNavigation(url: string, expectedHash = SPLASH_RETRY_HASH): boolean {
  try {
    return new URL(url).hash === expectedHash;
  } catch {
    return false;
  }
}

function splashDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

interface LinkedImportResponse {
  assetIds: string[];
  errors: Array<{ index: number; message: string }>;
}

interface RelocateLinkedSourceResponse {
  relocated: boolean;
}

// Everything the window needs from the shell process. Window creation and the
// native integration live here; the shell owns service/secret/dataRoot state
// and hands it over as a snapshot plus callbacks, so this module never
// reaches back into main.ts.
interface DesktopWindowHostBase {
  readonly origin: string;
  readonly preloadPath: string;
  readonly session?: Session;
  isQuitRequested(): boolean;
  setIpcHandlerRemover(remover: (() => void) | null): void;
  clearIpcHandlers(): void;
  onWindowClosed(): void;
  shutdown(): Promise<void>;
  /**
   * 启动画面失败后点「重试」时交给主进程重连。不提供时启动画面不显示重试，
   * 避免给用户一个点了没反应的按钮。
   */
  onSplashRetry?(): void;
}

export interface LocalDesktopWindowHost extends DesktopWindowHostBase {
  readonly mode: 'local';
  readonly service: DesktopService;
  readonly desktopSecret: string;
  readonly dataRoot: string;
  /** 启动画面失败重试：重新拉起私有服务并把窗口导航回真实页面。 */
  onSplashRetry(): void;
}

export interface RemoteClientIpc {
  chooseUploadFiles(window: BrowserWindow, target: RemoteUploadTarget): Promise<{ transferIds: string[] }>;
  pauseTransfer(transferId: string): void;
  resumeTransfer(transferId: string): void;
  cancelTransfer(transferId: string): Promise<void>;
  revealDownload(downloadId: string): Promise<{ revealed: boolean }>;
  getClientStatus(): Promise<ClientStatus>;
  installClientUpdate(): Promise<{ started: boolean; message?: string }>;
  reportUiError(input: ClientDiagnosticInput): void;
  pauseForUpdate(): Promise<void>;
  resumeAfterUpdate(): Promise<void>;
  stop(): Promise<void>;
}

export interface RemoteDesktopWindowHost extends DesktopWindowHostBase {
  readonly mode: 'remote';
  readonly session: Session;
  readonly remote: RemoteClientIpc;
}

export type DesktopWindowHost = LocalDesktopWindowHost | RemoteDesktopWindowHost;

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
  host: LocalDesktopWindowHost,
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
    revealItem: async (relativePath) => {
      // 与 openFolder 同款守卫：只接受工作台存储目录内的相对路径；文件定位还
      // 必须指向真实存在的文件，避免把资源管理器落到任意路径。
      if (
        typeof relativePath !== 'string'
        || relativePath.length === 0
        || isAbsolute(relativePath)
        || relativePath.split(/[\\/]+/).includes('..')
        || !(relativePath === 'storage' || relativePath.startsWith('storage/') || relativePath.startsWith('storage\\'))
      ) {
        throw new Error('只允许定位工作台存储目录内的文件');
      }
      const absolute = resolve(host.dataRoot, relativePath);
      const contained = relative(host.dataRoot, absolute);
      if (contained === '' || contained.startsWith('..') || isAbsolute(contained)) {
        throw new Error('只允许定位工作台存储目录内的文件');
      }
      if (!existsSync(absolute)) throw new Error('文件不存在或已被移动');
      shell.showItemInFolder(absolute);
      return { revealed: true };
    },
    setThemePreference: (preference) => {
      applyThemePreference(preference);
    },
    chooseUploadFiles: async () => { throw new Error('仅轻客户端支持受控上传'); },
    pauseTransfer: () => { throw new Error('仅轻客户端支持受管传输'); },
    resumeTransfer: () => { throw new Error('仅轻客户端支持受管传输'); },
    cancelTransfer: async () => { throw new Error('仅轻客户端支持受管传输'); },
    revealDownload: async () => { throw new Error('仅轻客户端支持受管下载'); },
    getClientStatus: async () => { throw new Error('当前不是轻客户端'); },
    installClientUpdate: async () => { throw new Error('本地工作台不使用轻客户端更新入口'); },
    reportClientError: () => { throw new Error('本地工作台不使用轻客户端错误上报入口'); },
  };
}

function createRemoteIpcHandlers(window: BrowserWindow, host: RemoteDesktopWindowHost): DesktopIpcHandlers {
  const localOnly = (): never => { throw new Error('本机实拍协议与工作台 dataRoot 操作仅在本地桌面可用'); };
  return {
    platform: () => process.platform === 'darwin' ? 'macos' : 'windows',
    chooseMediaFiles: async () => { localOnly(); throw new Error('unreachable'); },
    chooseFolder: async () => { localOnly(); throw new Error('unreachable'); },
    getAppVersion: () => app.getVersion(),
    relocateLinkedSource: async () => { localOnly(); throw new Error('unreachable'); },
    openFolder: async () => { localOnly(); throw new Error('unreachable'); },
    revealItem: async () => { localOnly(); throw new Error('unreachable'); },
    setThemePreference: (preference) => applyThemePreference(preference),
    chooseUploadFiles: (target) => host.remote.chooseUploadFiles(window, target),
    pauseTransfer: (transferId) => host.remote.pauseTransfer(transferId),
    resumeTransfer: (transferId) => host.remote.resumeTransfer(transferId),
    cancelTransfer: (transferId) => host.remote.cancelTransfer(transferId),
    revealDownload: (downloadId) => host.remote.revealDownload(downloadId),
    getClientStatus: () => host.remote.getClientStatus(),
    installClientUpdate: () => host.remote.installClientUpdate(),
    reportClientError: (input) => host.remote.reportUiError(input),
  };
}

function installIpcHandlers(window: BrowserWindow, host: DesktopWindowHost): void {
  const removeHandlers = registerIpcHandlers({
    window,
    origin: host.origin,
    handlers: host.mode === 'remote'
      ? createRemoteIpcHandlers(window, host)
      : createDesktopIpcHandlers(window, host),
  });
  host.setIpcHandlerRemover(removeHandlers);
}

// 任务栏 / 窗口图标取构建产物里的 256 像素 PNG（新标志）。源码运行与
// standalone 两种布局都试一遍，都找不到时交给 Electron 的默认图标。
function resolveWindowIconPath(): string | undefined {
  const projectRoot = resolve(__dirname, '..');
  const candidates = [
    join(projectRoot, 'public', 'icons', 'app-icon-256.png'),
    join(projectRoot, '.next', 'standalone', 'public', 'icons', 'app-icon-256.png'),
    process.resourcesPath ? join(process.resourcesPath, 'app', 'public', 'icons', 'app-icon-256.png') : '',
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

interface DesktopWindowShell {
  readonly preloadPath: string;
  readonly session?: Session;
  isQuitRequested(): boolean;
  setIpcHandlerRemover(remover: (() => void) | null): void;
  clearIpcHandlers(): void;
  onWindowClosed(): void;
  /** 工作台的 loopback origin；服务尚未就绪时为 null（此时只显示启动画面）。 */
  currentOrigin(): string | null;
}

// 唯一的生产 BrowserWindow 构造点：安全基线、导航守卫、关闭守卫全部在这里，
// 启动画面与工作台复用同一个窗口（不创建第二个 webContents）。
function createDesktopWindow(host: DesktopWindowShell): BrowserWindow {
  const icon = resolveWindowIconPath();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    title: SPLASH_BRAND,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: host.preloadPath,
      session: host.session,
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
  const origin = host.currentOrigin();
  window.webContents.on('will-navigate', (event, url) => {
    if (!origin || !sameOrigin(url, origin)) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler((details) => {
    if (origin && sameOrigin(details.url, origin)) {
      window.webContents.downloadURL(details.url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  window.on('close', (event) => {
    // Keep the window alive until the shared quit flow has finished (or the
    // user cancels). Repeated close clicks must not bypass confirmation.
    event.preventDefault();
    if (!host.isQuitRequested()) app.quit();
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    host.onWindowClosed();
    host.clearIpcHandlers();
  });
  return window;
}

/**
 * 桌面运行壳的启动流程：窗口先显示本地启动画面（标志 + 端名 + 连接状态），
 * 主进程连上服务后调用 connected() 装 IPC 并进入工作台；连不上调用
 * failed() 写明原因并给出重试按钮。
 */
export interface StartupWindow {
  readonly window: BrowserWindow;
  /** 服务已就绪：装好 IPC 并导航到工作台。 */
  connected(host: LocalDesktopWindowHost): void;
  /** 连接失败：把原因写到启动画面上，并交给调用方决定重试。 */
  failed(reason: string): void;
  /** 重新开始时回到「正在连接服务器」。 */
  connecting(): void;
}

export function createStartupWindow(
  options: Pick<DesktopWindowShell, 'preloadPath' | 'session' | 'isQuitRequested' | 'setIpcHandlerRemover' | 'clearIpcHandlers' | 'onWindowClosed'> & {
    retry?(): void;
  },
): StartupWindow {
  const shell: DesktopWindowShell = { ...options, currentOrigin: () => null };
  const window = createDesktopWindow(shell);
  const loadSplash = (state: SplashState) => {
    if (window.isDestroyed()) return;
    void window.loadURL(splashDataUrl(renderSplashHtml(state)));
  };
  // 先画启动画面再等主进程连服务：窗口一出场就有内容，不会白屏。
  loadSplash({ phase: 'connecting' });

  // 重试走页内锚点：只认 shell 自己写进启动画面的那个 hash，
  // 其余页内跳转一律忽略。
  window.webContents.on('did-navigate-in-page', (_event, url) => {
    if (!isSplashRetryNavigation(url)) return;
    loadSplash({ phase: 'connecting' });
    options.retry?.();
  });

  return {
    window,
    connected(host: LocalDesktopWindowHost) {
      installIpcHandlers(window, host);
      if (window.isDestroyed()) return;
      void window.loadURL(host.origin);
    },
    failed(reason: string) {
      loadSplash({ phase: 'failed', reason: splashFailureReason(reason) });
    },
    connecting() {
      loadSplash({ phase: 'connecting' });
    },
  };
}

export function createWindow(host: DesktopWindowHost): BrowserWindow {
  const origin = host.origin;
  const window = createDesktopWindow({ ...host, currentOrigin: () => origin });

  installIpcHandlers(window, host);

  if (host.mode === 'remote') {
    window.webContents.on('did-finish-load', () => {
      void import('./client/ui-diagnostics').then(({ CLIENT_UI_DIAGNOSTICS_SCRIPT }) =>
        window.webContents.executeJavaScript(CLIENT_UI_DIAGNOSTICS_SCRIPT, true),
      ).catch(() => undefined);
    });
  }
  void window.loadURL(origin);
  return window;
}
