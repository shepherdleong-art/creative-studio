import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(root, 'desktop');
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const excludedDirectories = new Set([
  '.agents', '.claude', '.codex', '.git', '.next', '.worktrees',
  'dist', 'dist-desktop', 'docs', 'node_modules',
  'outputs', 'storage', 'test', 'tests', '__tests__',
]);

// Fixed literals from the execution document; never derive expected values
// from the implementation under test.
const expectedBridgeMethods = [
  'platform', 'chooseMediaFiles', 'chooseFolder', 'getAppVersion', 'relocateLinkedSource', 'openFolder',
];
const expectedChannels = [
  'desktop:platform',
  'desktop:choose-media-files',
  'desktop:choose-folder',
  'desktop:get-app-version',
  'desktop:relocate-linked-source',
  'desktop:open-folder',
  'desktop:linked-import-progress',
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function isTestFile(relativePath) {
  return /(?:^|[\\/])(?:test|tests|__tests__)(?:[\\/]|$)/.test(relativePath)
    || /(?:\.test|\.spec)\.[^.]+$/.test(relativePath);
}

function sourceFiles(directory, relativeDirectory = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !excludedDirectories.has(entry.name)) {
        result.push(...sourceFiles(absolutePath, relativePath));
      }
    } else if (
      entry.isFile()
      && sourceExtensions.has(path.extname(entry.name))
      && !isTestFile(relativePath)
    ) {
      result.push({ absolutePath, relativePath });
    }
  }
  return result;
}

// The checked objects/functions are small and contain no brace-bearing
// template literals. Keep this helper intentionally narrow and transparent.
function braceBlock(source, marker, from = 0) {
  const markerIndex = source.indexOf(marker, from);
  assert.notEqual(markerIndex, -1, `缺少 ${marker}`);
  const open = source.indexOf('{', markerIndex + marker.length);
  assert.notEqual(open, -1, `${marker} 后缺少块`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return { open, source: source.slice(open + 1, index) };
  }
  throw new Error(`${marker} 的块没有闭合`);
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function moduleSpecifiers(source) {
  return [...source.matchAll(
    /\b(?:from|import|require)\s*(?:\(\s*)?["'`]([^"'`]+)["'`]/g,
  )].map((match) => match[1]);
}

function channelLiterals(source) {
  return [...source.matchAll(/["'`](desktop:[a-z0-9-]+)["'`]/g)].map(
    (match) => match[1],
  );
}

const production = sourceFiles(root);
const main = read('desktop/main.ts');
const ipc = read('desktop/ipc.ts');
const preload = read('desktop/preload.ts');
const bridgeTypes = read('desktop/bridge-types.ts');

// A. desktop/ stays a pure shell boundary; the standalone server wrapper is
// outside it and relative imports from the shell cannot escape the directory.
const desktopSources = production.filter((file) => inside(desktopRoot, file.absolutePath));
assert.ok(desktopSources.length > 0, 'desktop/ 必须包含可检查源码');
for (const file of desktopSources) {
  const source = fs.readFileSync(file.absolutePath, 'utf8');
  assert.doesNotMatch(
    source,
    /\b(?:better-sqlite3|sharp|ffmpeg-static|ffprobe-static)\b/,
    `${file.relativePath} 不得触达 native 业务依赖`,
  );
  for (const specifier of moduleSpecifiers(source)) {
    if (specifier.startsWith('.')) {
      assert.equal(
        inside(desktopRoot, path.resolve(path.dirname(file.absolutePath), specifier)),
        true,
        `${file.relativePath} 的相对 import 越出 desktop/: ${specifier}`,
      );
    } else {
      assert.equal(
        specifier === 'electron' || specifier.startsWith('node:'),
        true,
        `${file.relativePath} 只能加载 Electron、Node 内置模块或 desktop/ 内相对模块: ${specifier}`,
      );
    }
  }
  assert.doesNotMatch(
    source,
    /\b(?:import|require)\s*\(/,
    `${file.relativePath} 不得使用无法静态追踪的动态 import/require`,
  );
}
assert.equal(fs.existsSync(path.join(root, 'runtime/server-entry.js')), true);
assert.equal(fs.existsSync(path.join(desktopRoot, 'server-entry.js')), false);

// B. Exactly one production BrowserWindow has the complete explicit baseline.
const browserWindows = production.flatMap((file) => {
  const source = fs.readFileSync(file.absolutePath, 'utf8');
  return [...source.matchAll(/\bnew\s+BrowserWindow\s*\(/g)].map((match) => ({ file, index: match.index }));
});
assert.equal(browserWindows.length, 1, '生产源码必须恰好创建一个 BrowserWindow');
assert.equal(browserWindows[0].file.relativePath, path.join('desktop', 'main.ts'));
for (const file of production) {
  const source = fs.readFileSync(file.absolutePath, 'utf8');
  assert.doesNotMatch(
    source,
    /\b(?:new\s+(?:WebContentsView|BrowserView)\s*\(|webContents\.create\s*\()/,
    `${file.relativePath} 不得创建未套用安全基线的第二 webContents`,
  );
}
const windowBlock = braceBlock(main, 'new BrowserWindow', browserWindows[0].index);
const preferences = braceBlock(main, 'webPreferences:', windowBlock.open);
for (const [name, pattern] of [
  ['preload', /\bpreload\s*:/],
  ['nodeIntegration', /\bnodeIntegration\s*:\s*false\b/],
  ['contextIsolation', /\bcontextIsolation\s*:\s*true\b/],
  ['sandbox', /\bsandbox\s*:\s*true\b/],
  ['webSecurity', /\bwebSecurity\s*:\s*true\b/],
  ['webviewTag', /\bwebviewTag\s*:\s*false\b/],
]) {
  assert.match(preferences.source, pattern, `webPreferences 必须显式包含 ${name}`);
}

// C. The bridge exposes exactly the six named methods. Progress is a
// separately fixed main→preload event and never becomes a renderer method.
const typeBlock = braceBlock(bridgeTypes, 'interface DesktopBridge');
const typeMethods = [...typeBlock.source.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\(/gm)].map(
  (match) => match[1],
);
assert.deepEqual(typeMethods, expectedBridgeMethods, 'DesktopBridge 方法集合漂移');
const exposedBlock = braceBlock(preload, 'const desktopBridge: DesktopBridge = Object.freeze');
const exposedMethods = [...exposedBlock.source.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*\(/gm)].map(
  (match) => match[1],
);
assert.deepEqual(exposedMethods, expectedBridgeMethods, 'preload 暴露的方法集合漂移');
assert.equal(
  (preload.match(/contextBridge\.exposeInMainWorld\s*\(/g) ?? []).length,
  1,
  'preload 必须只暴露一个具名白名单对象',
);
assert.match(preload, /contextBridge\.exposeInMainWorld\(\s*['"]desktopBridge['"]\s*,\s*desktopBridge\s*\)/);
assert.doesNotMatch(preload, /contextBridge\.exposeInMainWorld\([^)]*,\s*ipcRenderer\b/);
assert.doesNotMatch(preload, /\b(?:fs|path|child_process)\b/);
assert.doesNotMatch(preload, /\bipcRenderer\.(?:once|send|sendSync|postMessage|removeListener)\b/);
assert.equal((preload.match(/\bipcRenderer\.on\(/g) ?? []).length, 1);
assert.match(preload, /ipcRenderer\.on\(\s*LINKED_IMPORT_PROGRESS_CHANNEL\s*,/);
assert.match(preload, /creative-studio:linked-import-progress/);
assert.doesNotMatch(preload, /\bipcRenderer\.invoke\(\s*channel\b/);
assert.equal((preload.match(/ipcRenderer\.invoke\(/g) ?? []).length, 6);
assert.equal(
  [...preload.matchAll(/ipcRenderer\.invoke\(\s*([A-Z][A-Z0-9_]*_CHANNEL)\s*\)/g)].length,
  4,
  '四个无参 preload invoke 必须使用固定 channel 常量',
);
assert.match(
  preload,
  /ipcRenderer\.invoke\(\s*RELOCATE_LINKED_SOURCE_CHANNEL\s*,\s*assetId\s*,\s*sourceId\s*,?\s*\)/,
  '重新定位 bridge 必须精确传递 assetId 与 sourceId',
);
assert.match(
  preload,
  /ipcRenderer\.invoke\(\s*OPEN_FOLDER_CHANNEL\s*,\s*relativePath\s*,?\s*\)/,
  '打开文件夹 bridge 必须精确传递 relativePath',
);

// D. All six handlers use the one protected wrapper and validate frame/origin.
const allHandlers = production.flatMap((file) => {
  const source = fs.readFileSync(file.absolutePath, 'utf8');
  return [...source.matchAll(/ipcMain\.handle\(/g)].map(() => file);
});
assert.equal(allHandlers.length, 6, '生产源码必须恰好注册六个 ipcMain.handle');
assert.ok(allHandlers.every((file) => file.relativePath === path.join('desktop', 'ipc.ts')));
assert.equal(
  (ipc.match(/ipcMain\.handle\(\s*[^,]+,\s*protectedHandler\(/g) ?? []).length,
  6,
  '每个 ipcMain.handle 必须直接通过 protectedHandler',
);
assert.match(ipc, /const\s+senderFrame\s*=\s*event\.senderFrame/);
assert.match(ipc, /senderFrame\s*!==\s*options\.window\.webContents\.mainFrame/);
assert.match(ipc, /sameOrigin\(\s*senderFrame\.url\s*,\s*options\.origin\s*\)/);
assert.match(ipc, /assertAllowedSender\(\s*event\s*,\s*options\s*\)/);
const originBlock = braceBlock(ipc, 'function sameOrigin');
assert.equal((originBlock.source.match(/\bnew URL\s*\(/g) ?? []).length, 2);
for (const property of ['protocol', 'hostname', 'port']) {
  assert.match(originBlock.source, new RegExp(`leftUrl\\.${property}\\s*===\\s*rightUrl\\.${property}`));
}
assert.doesNotMatch(ipc, /\.startsWith\s*\(/, 'IPC sender URL 校验不得使用 startsWith');

// E. Renderer navigation and window opening are deny-by-default.
const navigation = braceBlock(main, "webContents.on('will-navigate'");
assert.match(navigation.source, /\bsameOrigin\s*\(/);
assert.match(navigation.source, /\bevent\.preventDefault\(\)/);
assert.doesNotMatch(navigation.source, /\.startsWith\s*\(/);
const windowOpenHandler = braceBlock(main, 'setWindowOpenHandler');
assert.match(windowOpenHandler.source, /sameOrigin\(\s*details\.url\s*,\s*origin\s*\)/);
assert.match(windowOpenHandler.source, /webContents\.downloadURL\(\s*details\.url\s*\)/);
assert.match(windowOpenHandler.source, /action\s*:\s*['"]deny['"]/);
assert.doesNotMatch(windowOpenHandler.source, /action\s*:\s*['"]allow['"]/);

// F. The top-level single-instance lock precedes service/window side effects.
const lock = main.indexOf('app.requestSingleInstanceLock()');
assert.notEqual(lock, -1);
assert.match(main, /^const singleInstanceLock = app\.requestSingleInstanceLock\(\);$/m);
assert.ok(lock < main.search(/\bstartService\s*\(/));
assert.ok(lock < main.search(/\bnew\s+BrowserWindow\s*\(/));

// G. The intentionally duplicated sandbox-safe channel literals stay equal to
// the fixed public set in both ipc.ts and preload.ts.
assert.equal(channelLiterals(ipc).length, expectedChannels.length);
assert.equal(channelLiterals(preload).length, expectedChannels.length);
assert.deepEqual([...new Set(channelLiterals(ipc))].sort(), [...expectedChannels].sort());
assert.deepEqual([...new Set(channelLiterals(preload))].sort(), [...expectedChannels].sort());

console.log('electron shell security contract test passed');
