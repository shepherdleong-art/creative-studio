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

const calls = { starts: 0, stops: 0, remoteHosts: 0, exits: 0, shutdownRequests: 0, errors: [] };
const app = new EventEmitter();
app.requestSingleInstanceLock = () => true;
app.isPackaged = false;
app.getPath = (name) => path.join('fake-electron', name);
app.getVersion = () => '0.7.1';
app.whenReady = () => Promise.resolve();
app.quit = () => {};
app.exit = () => { calls.exits += 1; };
const remoteSession = { name: 'shared-team-session' };
const remoteController = { async stop() {}, async pauseForUpdate() {}, async resumeAfterUpdate() {} };
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
    defaultClientStateRoot: () => path.join('fake-electron', 'client-state'),
    confirmRemoteClientHealth: async () => {},
    createRemoteClientHost: async (options) => {
      calls.remoteHosts += 1;
      assert.equal(options.origin, 'https://studio.example.test');
      return remoteHost;
    },
  },
  './client/update-helper': { spawnIndependentUpdateHelper: async () => ({ jobId: 'test-job' }) },
  './window': { createWindow: (host) => { assert.equal(host, remoteHost); return fakeWindow; } },
  './ipc': { CHANNELS: { quitRequested: 'desktop:quit-requested' } },
  './reassembled-navigation': {
    consumeFilmNavigationRequest: () => { throw new Error('remote must not read local film navigation'); },
    completeFilmNavigation: () => {},
  },
};
process.env.CREATIVE_STUDIO_CLIENT_MODE = 'remote';
process.env.CREATIVE_STUDIO_SERVER_ORIGIN = 'https://studio.example.test/path-that-must-be-rejected';
const { readRemoteClientConfig } = load('desktop/client/remote-host.ts', {
  electron: { app },
  './remote-transfer': { RemoteTransferController: class {} },
});
assert.throws(() => readRemoteClientConfig(process.env), /origin|来源|地址/i);
process.env.CREATIVE_STUDIO_SERVER_ORIGIN = 'https://studio.example.test';
load('desktop/main.ts', modules, { setInterval, clearInterval });
await tick();
await tick();
assert.equal(calls.remoteHosts, 1, calls.errors.join('\n'));
assert.equal(calls.starts, 0, 'remote Host 不得 spawn 生产后台');
assert.equal(calls.shutdownRequests, 0, 'remote 启动不得发公共 shutdown');

const remoteSource = fs.readFileSync('desktop/window.ts', 'utf8');
assert.match(remoteSource, /session:\s*host\.session/, 'remote BrowserWindow 与原生传输必须共用 Session');
assert.doesNotMatch(remoteSource, /webSecurity:\s*false|contextIsolation:\s*false|sandbox:\s*false/);
assert.match(fs.readFileSync('desktop/main.ts', 'utf8'), /client\/remote-host/);
console.log('team client remote host tests passed');
