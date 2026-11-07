// 桌面启动画面：不启 Electron 也能测到「连接失败显示原因 + 重试」的核心逻辑。
//
// 覆盖方式说明：启动画面是一个纯字符串渲染函数（desktop/window.ts 的
// renderSplashHtml / isSplashRetryNavigation），不需要真实 BrowserWindow。
// 这里用 node:vm + TypeScript transpile 加载 desktop/window.ts，用假的 electron
// 模块跑通 createStartupWindow 的完整流程：先画「正在连接服务器」，连不上时
// 写清原因并给出重试入口，点重试回到「正在连接」，连上后导航到工作台。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadTs(file: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    },
  }).outputText;
  const loaded: { exports: Record<string, unknown> } = { exports: {} };
  vm.runInNewContext(source, {
    module: loaded, exports: loaded.exports,
    require: (name: string) => modules[name] ?? require(name),
    __dirname: path.resolve('desktop'),
    process: { ...process, resourcesPath: '' },
    URL,
    encodeURIComponent,
    ...globals,
  }, { filename: file });
  return loaded.exports;
}

// ---------- 假 BrowserWindow：记录每次加载的 URL ----------

class FakeWebContents extends EventEmitter {
  loads: string[] = [];
  setWindowOpenHandler() {}
  executeJavaScript() { return Promise.resolve(); }
  send() {}
}

class FakeWindow extends EventEmitter {
  webContents = new FakeWebContents();
  destroyed = false;
  shown = false;
  loadURLCalls: string[] = [];
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) { super(); this.options = options; }
  loadURL(url: string) { this.loadURLCalls.push(url); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  show() { this.shown = true; }
  focus() {}
  setTitle() {}
}

const windows: FakeWindow[] = [];
const ipcCalls: string[] = [];
const electron = {
  app: { quit() {}, getVersion: () => '0.7.1', getPath: () => '/fake' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder() {} },
  BrowserWindow: class extends FakeWindow {
    constructor(options: Record<string, unknown>) { super(options); windows.push(this); }
  },
};

const modules = {
  electron,
  './ipc': {
    CHANNELS: { linkedImportProgress: 'desktop:linked-import-progress', quitRequested: 'desktop:quit-requested' },
    registerIpcHandlers: () => { ipcCalls.push('registered'); return () => { ipcCalls.push('removed'); }; },
    sameOrigin: (left: string, right: string) => {
      try {
        const a = new URL(left); const b = new URL(right);
        return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
      } catch { return false; }
    },
  },
  './theme': { applyThemePreference: () => {} },
  './client/ui-diagnostics': { CLIENT_UI_DIAGNOSTICS_SCRIPT: '' },
};

const windowModule = loadTs('desktop/window.ts', modules) as {
  renderSplashHtml(state: { phase: 'connecting' | 'failed'; reason?: string }, theme?: 'light' | 'dark'): string;
  createStartupWindow(options: Record<string, unknown>): {
    window: FakeWindow;
    connected(host: unknown): void;
    failed(reason: string): void;
    connecting(): void;
  };
  isSplashRetryNavigation(url: string): boolean;
  splashFailureReason(error: unknown): string;
  SPLASH_RETRY_HASH: string;
};

// ---------- 1. 纯渲染：标志 + 端名 + 连接状态，零外链 ----------

const connectingHtml = windowModule.renderSplashHtml({ phase: 'connecting' });
assert.match(connectingHtml, /<!DOCTYPE html>/);
assert.match(connectingHtml, /林视 Lin's Vision/, '启动画面必须显示端名');
assert.match(connectingHtml, /AI 产品图与短视频创作工作台/, '启动画面必须有副题');
assert.match(connectingHtml, /正在连接服务器/, '正常时必须显示连接状态');
assert.match(connectingHtml, /<svg class="mark"/, '启动画面必须有标志');
assert.match(connectingHtml, /#46A97B/, '标志必须是新品牌绿色');
assert.doesNotMatch(connectingHtml, /产品素材工作台|Creative Studio/, '不得残留旧显示名');
// 不依赖服务器上的任何资源：没有任何 http(s)/协议相对外链，也没有外部字体/图片。
assert.doesNotMatch(connectingHtml, /(?:src|href)\s*=\s*["'](?:https?:)?\/\//, '启动画面不得引用外部资源');
assert.doesNotMatch(connectingHtml, /@import|url\((?:https?:)?\/\//, '启动画面不得外链样式或字体');
assert.doesNotMatch(connectingHtml, /<link\b/, '启动画面不得引用外部样式表');
assert.doesNotMatch(connectingHtml, /<script\b/, '启动画面不需要脚本，避免引入额外权限面');

// 失败态：写明原因 + 重试按钮。
const failedHtml = windowModule.renderSplashHtml({ phase: 'failed', reason: '私有 Node 服务在 30000ms 内没有回传端口' });
assert.match(failedHtml, /连接服务器失败/);
assert.match(failedHtml, /私有 Node 服务在 30000ms 内没有回传端口/, '失败时必须写清具体原因');
assert.match(failedHtml, /role="alert"/, '失败原因必须可被辅助技术播报');
assert.match(failedHtml, /id="splash-retry"/, '失败时必须给出重试入口');
assert.match(failedHtml, /重试/);
assert.doesNotMatch(failedHtml, /正在连接服务器/);

// 原因里的 HTML 必须转义，不能把服务日志当标记渲染。
const escaped = windowModule.renderSplashHtml({ phase: 'failed', reason: '<img src=x onerror=alert(1)>' });
assert.doesNotMatch(escaped, /<img/, '失败原因必须转义');
assert.match(escaped, /&lt;img/);

// 长 stderr 尾巴要截断，别把整段日志糊在启动画面上。
const longTail = ['第一行原因', ...Array.from({ length: 30 }, (_, index) => `日志行 ${index + 1}`)].join('\n');
const trimmed = windowModule.splashFailureReason(longTail);
assert.match(trimmed, /第一行原因/);
assert.match(trimmed, /已省略/);
assert.ok(trimmed.split('\n').length <= 8, '失败原因必须截断到可读长度');

// 外观：浅深两态都能显式指定，缺省交给系统。
assert.match(windowModule.renderSplashHtml({ phase: 'connecting' }, 'dark'), /data-theme="dark"/);
assert.match(windowModule.renderSplashHtml({ phase: 'connecting' }, 'light'), /data-theme="light"/);
assert.match(connectingHtml, /prefers-color-scheme: dark/, '缺省时必须跟随系统外观');

// 重试信号只认自家 hash。
assert.equal(windowModule.isSplashRetryNavigation(`data:text/html,x${windowModule.SPLASH_RETRY_HASH}`), true);
assert.equal(windowModule.isSplashRetryNavigation('data:text/html,x#other'), false);
assert.equal(windowModule.isSplashRetryNavigation('http://127.0.0.1:3000/projects'), false);

// ---------- 2. 生命周期：连接中 → 失败（含原因）→ 重试 → 连上 ----------

let retries = 0;
const startup = windowModule.createStartupWindow({
  preloadPath: 'preload.js',
  isQuitRequested: () => false,
  setIpcHandlerRemover: () => {},
  clearIpcHandlers: () => {},
  onWindowClosed: () => {},
  retry: () => { retries += 1; },
});
const window = startup.window;
const loadedUrls = () => window.loadURLCalls;

// 首屏就是本地启动画面，不是服务器地址。
assert.equal(loadedUrls().length, 1, '窗口创建后应立刻显示启动画面');
assert.match(decodeURIComponent(loadedUrls()[0]), /正在连接服务器/);
assert.doesNotMatch(loadedUrls()[0], /^https?:/, '启动画面必须是本地 data: 文档');
assert.equal(window.options.title, "林视 Lin's Vision", '窗口标题必须是新名字');

// 连不上：画出原因并带重试。
startup.failed('私有 Node 服务在就绪前退出（code=1）');
const failureUrl = decodeURIComponent(loadedUrls().at(-1) ?? '');
assert.match(failureUrl, /连接服务器失败/);
assert.match(failureUrl, /私有 Node 服务在就绪前退出（code=1）/);
assert.match(failureUrl, /id="splash-retry"/);

// 点重试：走页内锚点，主进程收到回调并回到「正在连接」。
window.webContents.emit('did-navigate-in-page', {}, `data:text/html,x${windowModule.SPLASH_RETRY_HASH}`);
assert.equal(retries, 1, '重试必须回调主进程重连');
assert.match(decodeURIComponent(loadedUrls().at(-1) ?? ''), /正在连接服务器/, '重试后应回到连接中状态');

// 其它页内跳转不触发重试。
window.webContents.emit('did-navigate-in-page', {}, 'data:text/html,x#elsewhere');
assert.equal(retries, 1);

// 连上：装 IPC 并导航到真实工作台。
const host = {
  mode: 'local' as const,
  origin: 'http://127.0.0.1:45678',
  preloadPath: 'preload.js',
  service: { origin: 'http://127.0.0.1:45678', instanceId: 'x', getStatus: () => ({ state: 'ready' }), stop: async () => {} },
  desktopSecret: 'secret',
  dataRoot: '/data',
  isQuitRequested: () => false,
  setIpcHandlerRemover: () => {},
  clearIpcHandlers: () => {},
  onWindowClosed: () => {},
  shutdown: async () => {},
  onSplashRetry: () => {},
};
startup.connected(host);
assert.deepEqual(ipcCalls.slice(0, 1), ['registered'], '连上后才装 IPC');
assert.equal(loadedUrls().at(-1), 'http://127.0.0.1:45678', '连上后必须进入工作台');
assert.equal(windows.length, 1, '启动画面与工作台必须复用同一个窗口');

console.log('desktop splash tests passed');
