import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function load(file, modules, globals = {}) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(source, {
    module: loaded, exports: loaded.exports,
    require: (name) => modules[name] ?? require(name),
    __dirname: path.resolve('desktop'),
    process,
    URL,
    ...globals,
  }, { filename: file });
  return loaded.exports;
}

process.env.CREATIVE_STUDIO_CLIENT_INSTALL_ROOT = path.join('fake-electron', 'stable-install');
process.env.CREATIVE_STUDIO_CLIENT_STATE_ROOT = path.join(process.env.CREATIVE_STUDIO_CLIENT_INSTALL_ROOT, 'client-state');
const calls = { starts: 0, stops: 0, remoteHosts: 0, remoteStops: 0, exits: 0, shutdownRequests: 0, flushes: 0, userDataPaths: [], errors: [] };
const app = new EventEmitter();
app.requestSingleInstanceLock = () => true;
app.isPackaged = false;
app.getPath = (name) => path.join('fake-electron', name);
app.getVersion = () => '0.7.1';
app.setPath = (name, value) => { if (name === 'userData') calls.userDataPaths.push(value); };
app.whenReady = () => Promise.resolve();
app.quit = () => {};
app.exit = () => { calls.exits += 1; };
const remoteSession = { name: 'shared-team-session', async flushStorageData() { calls.flushes += 1; } };
const remoteController = { async stop() { calls.remoteStops += 1; }, async pauseForUpdate() {}, async resumeAfterUpdate() {}, reportUiError() {} };
const remoteHost = {
  mode: 'remote', origin: 'https://studio.example.test', preloadPath: 'preload.js',
  session: remoteSession, remote: remoteController,
  isQuitRequested: () => false,
  setIpcHandlerRemover() {}, clearIpcHandlers() {}, onWindowClosed() {},
  shutdown: async () => {},
};
const fakeWindow = new EventEmitter();
fakeWindow.webContents = new EventEmitter();
fakeWindow.webContents.send = () => { calls.shutdownRequests += 1; };
fakeWindow.isDestroyed = () => false;
fakeWindow.isMinimized = () => false;
fakeWindow.show = () => {};
fakeWindow.focus = () => {};
const modules = {
  electron: { app, dialog: { showMessageBox: async (options) => { calls.errors.push(options.message); } } },
  './service-spawn': {
    resolveServicePaths: () => ({}), resolveNodeExecutable: () => process.execPath,
    startService: async () => { calls.starts += 1; throw new Error('remote must not start service'); },
  },
  './client/remote-host': {
    readRemoteClientConfig: (env = process.env) => ({ mode: 'remote', origin: env.CREATIVE_STUDIO_SERVER_ORIGIN }),
    defaultClientStateRoot: () => process.env.CREATIVE_STUDIO_CLIENT_STATE_ROOT ?? path.join('fake-electron', 'client-state'),
    confirmRemoteClientHealth: async () => {},
    createRemoteClientHost: async (options) => {
      calls.remoteHosts += 1;
      assert.equal(options.origin, 'https://studio.example.test');
      return remoteHost;
    },
  },
  './client/update-helper': { spawnIndependentUpdateHelper: async () => ({ jobId: 'test-job' }) },
  './client/client-diagnostic-reporter': { ClientDiagnosticReporter: class {} },
  './client/ui-diagnostics': { installClientUiDiagnostics: () => () => {} },
  './window': { createWindow: (host) => { assert.equal(host, remoteHost); return fakeWindow; } },
  './ipc': { CHANNELS: { quitRequested: 'desktop:quit-requested' } },
  './reassembled-navigation': {
    consumeFilmNavigationRequest: () => { throw new Error('remote must not read local film navigation'); },
    completeFilmNavigation: () => {},
  },
};
process.env.CREATIVE_STUDIO_CLIENT_MODE = 'remote';
process.env.CREATIVE_STUDIO_SERVER_ORIGIN = 'https://studio.example.test/path-that-must-be-rejected';
const { readRemoteClientConfig, configureRemotePermissions } = load('desktop/client/remote-host.ts', {
  electron: { app },
  './remote-transfer': { RemoteTransferController: class {} },
  './client-diagnostic-reporter': { ClientDiagnosticReporter: class { setIdentity() {} report() {} } },
  './ui-diagnostics': { installClientUiDiagnostics: () => () => {} }, './client-diagnostics': {},
}, { process: { ...process, env: { ...process.env, CREATIVE_STUDIO_CLIENT_MODE: 'local' } } });
let requestPermission, checkPermission;
configureRemotePermissions({
  setPermissionRequestHandler: handler => { requestPermission = handler; },
  setPermissionCheckHandler: handler => { checkPermission = handler; },
}, 'https://studio.example.test');
const contents = { isDestroyed: () => false, getURL: () => 'https://studio.example.test/projects/one' };
for (const [permission, requestingUrl, isMainFrame, expected] of [
  ['fullscreen', 'https://studio.example.test/projects/one', true, true],
  ['fullscreen', 'https://other.example.test/', true, false],
  ['fullscreen', 'https://studio.example.test/', false, false],
  ['media', 'https://studio.example.test/', true, false],
  ['clipboard-read', 'https://studio.example.test/', true, false],
]) {
  const details = { requestingUrl, isMainFrame };
  requestPermission(contents, permission, result => assert.equal(result, expected), details);
  assert.equal(checkPermission(contents, permission, new URL(requestingUrl).origin, details), expected);
}
assert.throws(() => readRemoteClientConfig(process.env), /origin|来源|地址/i);
const localTeamConfig = {
  CREATIVE_STUDIO_CLIENT_MODE: 'local-team',
  CREATIVE_STUDIO_SERVER_ORIGIN: 'http://127.0.0.1:3400',
};
const localTeam = readRemoteClientConfig(localTeamConfig);
assert.equal(localTeam.mode, 'remote');
assert.equal(localTeam.origin, 'http://127.0.0.1:3400');
for (const origin of [
  'https://127.0.0.1:3400', 'http://localhost:3400', 'http://0.0.0.0:3400',
  'http://example.test:3400', 'http://127.0.0.1:3400/path',
]) {
  assert.throws(() => readRemoteClientConfig({ ...localTeamConfig, CREATIVE_STUDIO_SERVER_ORIGIN: origin }),
    /127\.0\.0\.1/, 'local-team 只允许无路径的 HTTP 回环 origin');
}
assert.throws(() => readRemoteClientConfig({
  CREATIVE_STUDIO_CLIENT_MODE: 'remote', CREATIVE_STUDIO_SERVER_ORIGIN: 'http://127.0.0.1:3400',
}), /HTTPS/, 'remote 的 HTTPS 要求不得被本地模式放宽');
process.env.CREATIVE_STUDIO_SERVER_ORIGIN = 'https://studio.example.test';
const safeSetTimeout = (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; };
load('desktop/main.ts', modules, { setInterval, clearInterval, setTimeout: safeSetTimeout, clearTimeout });
await tick();
await tick();
assert.equal(calls.remoteHosts, 1, calls.errors.join('\n'));
assert.equal(calls.starts, 0, 'remote Host 不得 spawn 生产后台');
assert.deepEqual(calls.userDataPaths, [path.join(process.env.CREATIVE_STUDIO_CLIENT_STATE_ROOT, 'electron')], '稳定 userData 必须在单实例锁与持久 Session 前设置');
assert.equal(calls.shutdownRequests, 0, 'remote 启动不得发公共 shutdown');
app.emit('before-quit', { preventDefault() {} });
await tick();
await tick();
assert.equal(calls.remoteStops, 1, 'remote 关闭必须停止本机传输控制器');
assert.equal(calls.flushes, 1, '退出必须等待持久 Session 的存储落盘');
assert.equal(calls.exits, 1, 'remote 关闭必须退出本机客户端');
assert.equal(calls.shutdownRequests, 0, 'remote 关闭不得发公共 shutdown');
remoteSession.flushStorageData = async () => { throw new Error('isolated storage failure'); };
load('desktop/main.ts', modules, { setInterval, clearInterval, setTimeout: safeSetTimeout, clearTimeout });
await tick();
await tick();
app.emit('before-quit', { preventDefault() {} });
await tick();
await tick();
assert.equal(calls.exits, 2, 'Cookie 持久化失败也不能阻止本机客户端退出');
remoteSession.flushStorageData = () => new Promise(() => {});
load('desktop/main.ts', modules, { setInterval, clearInterval, setTimeout: safeSetTimeout, clearTimeout });
await tick();
await tick();
const beforeBoundedQuit = Date.now();
app.emit('before-quit', { preventDefault() {} });
await new Promise(resolve => setTimeout(resolve, 2300));
assert.equal(calls.exits, 3, 'Cookie 持久化超时后仍必须有界退出本机客户端');
assert.ok(Date.now() - beforeBoundedQuit >= 1800 && Date.now() - beforeBoundedQuit < 6000, '异常持久化必须有明确的短超时边界');

const remoteSource = fs.readFileSync('desktop/window.ts', 'utf8');
assert.match(remoteSource, /session:\s*host\.session/, 'remote BrowserWindow 与原生传输必须共用 Session');
assert.doesNotMatch(remoteSource, /webSecurity:\s*false|contextIsolation:\s*false|sandbox:\s*false/);
const mainSource = fs.readFileSync('desktop/main.ts', 'utf8');
assert.match(mainSource, /client\/remote-host/);
assert.match(mainSource, /\['remote', 'local-team'\]/, 'local-team 必须在单实例锁前使用独立 userData');
console.log('team client remote host tests passed');
