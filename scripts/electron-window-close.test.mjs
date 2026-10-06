// Exercise main → preload → Header without stopping the real workbench.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function load(file, modules, globals = {}) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(source, {
    module: loaded, exports: loaded.exports,
    require: (name) => modules[name] ?? require(name),
    __dirname: path.resolve('desktop'),
    process: { env: {}, on() {} },
    ...globals,
  }, { filename: file });
  return loaded.exports;
}
async function launch() {
  const calls = { stops: 0, exits: 0, dialogs: 0, clears: 0, shutdownRequests: 0 };
  const stopped = deferred();
  const app = new EventEmitter();
  const ipcRenderer = new EventEmitter();
  const rendererWindow = {};
  const windows = [];
  let onServiceExit;
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel) => ipcRenderer.emit(channel, { sender: 'private' });
    }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    loadURL() { return Promise.resolve(); }
  }
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve();
  app.quit = () => {
    const quitEvent = event();
    app.emit('before-quit', quitEvent);
    assert.equal(quitEvent.prevented, true, 'native quit waits for in-page confirmation');
  };
  app.exit = () => { calls.exits += 1; };
  const electron = {
    app, ipcRenderer,
    contextBridge: { exposeInMainWorld: (name, value) => { rendererWindow[name] = value; } },
    BrowserWindow: FakeWindow,
    dialog: { showMessageBox: () => { calls.dialogs += 1; return Promise.resolve({ response: 0 }); } },
  };
  const service = {
    origin: 'http://127.0.0.1:12345',
    stop: () => { calls.stops += 1; return stopped.promise; },
  };
  const modules = {
    electron,
    './ipc': {
      CHANNELS: { quitRequested: 'desktop:quit-requested' },
      registerIpcHandlers: () => () => { calls.clears += 1; },
    },
    './theme': {},
    './service-spawn': {
      resolveServicePaths: () => ({}),
      resolveNodeExecutable: () => process.execPath,
      startService: async (options) => { onServiceExit = options.onUnexpectedExit; return service; },
    },
  };
  load('desktop/preload.ts', modules, { window: rendererWindow });
  modules['./window'] = load('desktop/window.ts', modules);
  load('desktop/main.ts', modules);
  await tick();
  function mountHeader() {
    const states = [];
    let cursor = 0;
    let mounted = false;
    let cleanup;
    const Header = load('components/Header.tsx', {
      react: {
        useState: (initial) => {
          const index = cursor++;
          if (!(index in states)) states[index] = initial;
          return [states[index], (value) => { states[index] = value; }];
        },
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        useEffect: (effect) => { if (!mounted) cleanup = effect(); },
      },
      'next/link': () => null,
      '@/components/ui/Icon': { Icon: () => null },
      '@/components/ThemeToggle': () => null,
    }, {
      window: rendererWindow,
      setTimeout: () => 0,
      fetch: async (url, options) => {
        assert.equal(url, '/api/shutdown');
        assert.equal(options.method, 'POST');
        calls.shutdownRequests += 1;
        onServiceExit();
      },
    }).default;
    function render() {
      cursor = 0;
      const tree = Header();
      mounted = true;
      return tree;
    }
    function find(predicate, node = render()) {
      if (!node || typeof node !== 'object') return undefined;
      if (predicate(node)) return node;
      for (const child of [node.props?.children].flat(Infinity)) {
        if (child == null) continue;
        const found = find(predicate, child);
        if (found) return found;
      }
    }
    render();
    return {
      hasDialog: () => Boolean(find((node) => node.type === 'h3' && node.props.children === '停止服务并退出')),
      click: (text) => {
        const button = find((node) => node.type === 'button' && (node.props.children === text || node.props['aria-label'] === text));
        assert.ok(button, `missing button: ${text}`);
        assert.ok(!button.props.disabled, `disabled button: ${text}`);
        return button.props.onClick();
      },
      unmount: () => cleanup?.(),
    };
  }
  return {
    app, calls, stopped, mountHeader,
    close() {
      const closeEvent = event();
      windows[0].emit('close', closeEvent);
      assert.equal(closeEvent.prevented, true, 'window remains open for confirmation');
    },
  };
}
{
  const shell = await launch();
  const header = shell.mountHeader();
  assert.equal(header.hasDialog(), false);
  shell.close();
  shell.close();
  shell.app.quit();
  assert.equal(header.hasDialog(), true);
  assert.equal(shell.calls.dialogs, 0, 'no native confirmation');
  assert.equal(shell.calls.shutdownRequests, 0, 'X alone must not stop services');
  assert.equal(shell.calls.clears, 0, 'IPC remains usable before confirmation');
  header.click('取消');
  assert.equal(header.hasDialog(), false);
  header.click('停止服务');
  assert.equal(header.hasDialog(), true, 'power button opens the same dialog');
  header.click('取消');
  shell.close();
  await header.click('确定关闭并退出');
  assert.equal(shell.calls.shutdownRequests, 1);
  assert.equal(shell.calls.stops, 1);
  assert.equal(shell.calls.exits, 0, 'wait for service cleanup');
  shell.close();
  shell.app.quit();
  shell.stopped.resolve();
  await tick();
  assert.equal(shell.calls.exits, 1);
  header.unmount();
}
// An early close click or a click between Header mounts must not get lost.
{
  const shell = await launch();
  shell.close();
  const header = shell.mountHeader();
  assert.equal(header.hasDialog(), true);
  header.click('取消');
  header.unmount();
  shell.close();
  const replacement = shell.mountHeader();
  assert.equal(replacement.hasDialog(), true);
  assert.equal(shell.calls.shutdownRequests, 0);
  assert.equal(shell.calls.dialogs, 0);
  replacement.unmount();
}
console.log('electron window close tests passed');
