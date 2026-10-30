# 实拍混剪移出工作台 · 任务索引

依据：[确认单](../../specs/2026-10-30-实拍混剪移出工作台-确认单.md)（已确认，`ready-for-agent`）。

2026-10-30 用户确认了这 8 张任务单的粗细和先后，并要求先只写文档、不动手。谁来执行、什么时候执行，等用户安排。

## 任务列表

| 编号 | 任务 | 要先做完 | 状态 |
| --- | --- | --- | --- |
| 01 | [独立应用推到 GitHub 私有仓库](01-独立应用推到GitHub私有仓库.md) | 无 | `ready-for-agent` |
| 02 | [规矩、任务单和试片放进独立应用](02-规矩任务单和试片放进独立应用.md) | 01 | `ready-for-agent` |
| 03 | [打书签，并断开别处对实拍混剪的依赖](03-打书签并断开别处对实拍混剪的依赖.md) | 01 | `ready-for-agent` |
| 04 | [拿掉实拍混剪](04-拿掉实拍混剪.md) | 03 | `ready-for-agent` |
| 05 | [删掉媒体公共层里没人用的文件](05-删掉媒体公共层里没人用的文件.md) | 04 | `ready-for-agent` |
| 06 | [工作台文档改成「已迁出」](06-工作台文档改成已迁出.md) | 02 | `ready-for-agent` |
| 07 | [整体复验、推送 GitHub、清旧分支](07-整体复验推送并清旧分支.md) | 04、05、06 | `ready-for-agent` |
| 08 | [清本机旧数据](08-清本机旧数据.md) | 02、07 | `ready-for-agent`（开始前要用户关掉桌面版，最后一步由用户确认） |

```
01 ─┬─→ 02 ─────→ 06 ──────────┐
    └─→ 03 ─→ 04 ─→ 05 ────────┼─→ 07 ─→ 08
        （08 还要等 02 做完）    ┘
```

- 02 和 03 可以同时做。06 只等 02，可以和 03–05 同时做。
- 01、02 改的是独立应用，03–08 改的是工作台。

## 两个仓库

- **工作台：** `/Users/liangpeijian/for-cc/creative-studio`，分支 `main`，远端 `shepherdleong-art/creative-studio`。
- **独立应用：** `/Users/liangpeijian/for-cc/实拍混剪-AI-movie-cutting`，主干 `integration/live-mixcut-extraction`。另一个 AI 在那边有没提交的复审整改，一个都不能碰。

## 所有任务都要守的规矩

1. **提交：** 工作台的提交直接进 `main`，一张任务单提交一次。工作台只在 07 推送；01、02 推的是独立应用。
2. **点名提交：** 提交时逐个点名文件。不用 `git add -A`、`git add .`、`git commit -a`。
3. **不碰别人的改动：** 开工时 `git status` 里已有的未提交改动都不是你的，一个都不碰，也不放进提交。2026-10-30 工作台里有这些：
   - `lib/creative-canvas/adapters/external.ts`
   - `lib/creative-canvas/video-metadata.ts`
   - `scripts/creative-canvas-providers.test.ts`
   - `lib/media-core/adapters/video-analysis.ts`
   - `scripts/video-analysis-frames.test.ts`
   - `docs/reference/单条素材分析.md`
   - `brand/`
   - `docs/2026-10-19-双视角评审-乔布斯与马斯克.md`

   动手前和提交后各跑一次 `git status --short`，这些条目必须原样还在。
4. **不跑 `npm run build`：** 它会替换仓库里的 `.next`，把用户正开着的桌面版弄坏。要构建，一律用附录 B 的隔离检查。
5. **不动用户的程序：** 不启动、不重启、不关闭用户的桌面版或开发服务器。08 需要关的时候，请用户自己关。
6. **不改写历史：** 不 force push，不改写已经推送的历史。
7. **不花钱：** 不调用任何收费模型。
8. **不改确认单：** 不改确认单里的决定。发现确认单写错了，停下来报告。
9. **遇到下面的情况，停下来报告，不要自己想办法绕过去：**
   - 任务单里写的文件、行号、数量和实际对不上（行号以 2026-10-30 为准，先按内容找到再改）；
   - 检查失败，而且原因不在本任务改动的范围里；
   - 要动「不要做」清单里的东西才能继续；
   - 推送被拒绝。

## 做完怎么记

- 状态改成 `done`。
- 文件末尾加「## 完成记录」，写清：
  - 做了什么、提交号；
  - 跑了哪些检查、结果是什么；
  - 和任务单不一样的地方。
- 没跑过的检查写「没跑」，不写「已通过」。
- 工作台任务单的完成记录随本任务的提交一起提交。06 会提交整个任务目录，07 会补交还没提交的完成记录。

## 附录：检查脚本

三个脚本都放在仓库外面，例如 `$TMPDIR/cs-removal/`，不要放进仓库。用法里的 `<仓库根目录>` 是工作台目录。

### A. 全部自动测试：`run-all-tests.mjs`

- 范围：`scripts/` 下的 `*.test.ts` 和 `*.test.mjs`，不含 Playwright。
- 每个测试单独一个进程，各用一个临时数据根，所以不会往真实的 `storage/` 写东西。超时 180 秒。
- **基线：** 03 动手前跑一次，`--out $TMPDIR/cs-removal/baseline.txt`。
- **之后：** 每次都加 `--out $TMPDIR/cs-removal/<任务号>.txt`。
- **怎么判断：** 新结果里的 FAIL 必须都在基线的 FAIL 里。基线是 0 个 FAIL 时，新结果也必须是 0 个。被删掉的测试不会出现在新结果里，不算。
- 全部跑完要一阵子。2026-10-30 试跑过其中两个，都通过。

```js
// 跑 scripts/ 下的全部自动测试：每个测试单独一个进程、单独一个临时数据根，超时 180 秒。
// 用法：node run-all-tests.mjs <仓库根目录> [--only 文件名片段] [--out 结果文件]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = fs.realpathSync(process.argv[2] ?? process.cwd());
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const only = arg('--only');
const out = arg('--out');
const timeoutMs = 180_000;
const names = fs.readdirSync(path.join(root, 'scripts'))
  .filter(n => /\.test\.(ts|mjs)$/.test(n) && !n.includes('.playwright.'))
  .filter(n => !only || n.includes(only))
  .sort();
const lines = [];
const failures = [];
for (const name of names) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join('scripts', name)], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: dataRoot },
    });
    let tail = '';
    const keep = chunk => { tail = (tail + chunk).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? signal, tail }); });
  });
  fs.rmSync(dataRoot, { recursive: true, force: true });
  const ok = result.code === 0;
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}`;
  console.log(`${line} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  lines.push(line);
  if (!ok) failures.push({ name, ...result });
}
console.log(`\n共 ${names.length} 个，通过 ${names.length - failures.length} 个，失败 ${failures.length} 个`);
for (const f of failures) console.log(`\n--- ${f.name}（退出：${f.code}）---\n${f.tail}`);
if (out) fs.writeFileSync(out, lines.join('\n') + '\n');
process.exitCode = failures.length ? 1 : 0;
```

### B. 隔离构建、类型检查和页面冒烟：`isolated-check.mjs`

- 它做这几件事：
  1. 在仓库 `.cache/` 下建临时目录（`.cache` 不进 Git），在里面做一次正式构建；
  2. 用构建刚生成的类型文件跑全项目类型检查；
  3. 在临时数据根上起一个临时服务，打开几个页面；
  4. 用完删掉临时目录。
- 它不替换仓库里的 `.next`，也不碰用户正开着的桌面版。
- **标记：**
  - `--asr-removed`：检查设置页没有「语音识别」、语音识别接口是 404；
  - `--live-mixcut-removed`：检查实拍混剪的页面和接口是 404。
- **2026-10-30 删除前试跑过：**
  - 不加标记：构建、类型检查、4 个页面全部通过，约 40 秒；
  - 加两个标记：删除相关的 4 项按预期失败。
- 「首页没有实拍混剪字样」这一项在临时服务里本来就过，因为临时服务没开实拍混剪开关。真正的证据是那两个 404。

```js
// 在仓库 .cache/ 下的临时目录里做一次正式构建、全项目类型检查和页面冒烟。
// 不替换仓库里的 .next，不碰正在运行的桌面版；用完删掉临时目录。
// 用法：node isolated-check.mjs <仓库根目录> [--asr-removed] [--live-mixcut-removed]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = fs.realpathSync(process.argv[2] ?? process.cwd());
const asrRemoved = process.argv.includes('--asr-removed');
const liveMixcutRemoved = process.argv.includes('--live-mixcut-removed');
const { prepareBuildInputs, materializeBuildLinks } = await import(path.join(root, 'scripts/build-production.mjs'));
fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
const stage = fs.mkdtempSync(path.join(root, '.cache', 'removal-check-'));
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-data-'));
const step = (label, args, cwd, env = process.env) => {
  console.log(`\n=== ${label}`);
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} 失败（退出 ${result.status ?? result.signal}）`);
};
let server;
try {
  prepareBuildInputs(root, stage);
  step('正式构建', [path.join(stage, 'node_modules/next/dist/bin/next'), 'build'], stage, { ...process.env, CREATIVE_STUDIO_DATA_ROOT: stage });
  materializeBuildLinks(stage);
  step('全项目类型检查', [path.join(stage, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', path.join(stage, 'tsconfig.json')], stage);

  const port = 3900 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(stage, '.next/standalone/server.js')], {
    cwd: path.join(stage, '.next/standalone'),
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', CREATIVE_STUDIO_DATA_ROOT: dataRoot, CREATIVE_STUDIO_CANVAS_ENABLE: '1' },
  });
  for (let i = 0; ; i++) {
    try { await fetch(`${base}/`); break; }
    catch { if (i >= 120) throw new Error('临时服务 60 秒内没有起来'); await new Promise(r => setTimeout(r, 500)); }
  }
  const get = async route => { const res = await fetch(base + route); return { status: res.status, html: await res.text() }; };
  const home = await get('/');
  const settings = await get('/settings');
  const checks = [
    ['首页能打开', home.status === 200],
    ['设置页能打开', settings.status === 200],
    ['画布页能打开', (await get('/canvas')).status === 200],
    ['新建项目页能打开', (await get('/projects/new')).status === 200],
  ];
  if (asrRemoved) {
    checks.push(['设置页没有「语音识别」', !settings.html.includes('语音识别')]);
    checks.push(['语音识别接口已删（404）', (await get('/api/providers/asr')).status === 404]);
  }
  if (liveMixcutRemoved) {
    checks.push(['首页没有「实拍混剪」字样', !home.html.includes('实拍混剪')]);
    checks.push(['实拍混剪页面已删（404）', (await get('/live-mixcut')).status === 404]);
    checks.push(['实拍混剪接口已删（404）', (await get('/api/live-mixcut/projects')).status === 404]);
  }
  console.log('\n=== 页面冒烟');
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  else console.log('\n全部通过');
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  if (server) {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 3000));
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
```

### C. 找没人用的文件：`find-unused.mjs`

- 它列出 `lib/`、`components/`、`app/` 里没有任何正式代码引用的文件。只被 `scripts/` 下的测试或脚本引用的，也算没人用。
- 用法：`node find-unused.mjs <仓库根目录>`。
- **2026-10-30 删除前的结果有 11 个：**
  - 8 个早就没人用的（不在本次范围，不要删）：
    - `lib/batch-production/output-editing.ts`
    - `lib/batch-production/output-media.ts`
    - `lib/batch-production/review.ts`
    - `lib/film-render/compare.ts`
    - `lib/film-render/from-project.ts`
    - `lib/film-render/gate.ts`
    - `lib/film-render/overlay-from-project.ts`
    - `lib/media-core/packaging-preview.ts`
  - 3 个在实拍混剪模块里面，04 会随模块一起删掉。
- **04 做完以后：** 应该是这 8 个，加上 05 要删的 11 个媒体公共层文件。
- **05 做完以后：** 应该只剩这 8 个。
- 2026-10-30 在一份删掉实拍混剪的副本上模拟过，结果和上面一致。

```js
// 列出 lib/、components/、app/ 里没有任何正式代码引用的文件。只被 scripts/ 下的测试或脚本引用，也算没人用。
import fs from 'node:fs';
import path from 'node:path';
const root = fs.realpathSync(process.argv[2] ?? process.cwd());
const skip = new Set(['node_modules', '.next', '.git', '.worktrees', '.cache', 'storage', 'data', 'outputs', 'dist', 'dist-desktop', 'python-runtime', '.venv-litellm', 'packaging', 'docs', 'brand', 'public']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); continue; }
    if (/\.(ts|tsx|mjs|js|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(path.join(dir, e.name));
  }
})(root);
const re = /(?:from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"])/gm;
function resolve(from, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(root, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(root, c);
  }
  return null;
}
const importers = new Map(files.map(f => [path.relative(root, f), new Set()]));
for (const f of files) {
  const rel = path.relative(root, f);
  for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
    const target = resolve(f, m[1] || m[2] || m[3] || m[4]);
    if (target && importers.has(target)) importers.get(target).add(rel);
  }
}
// 页面、布局、接口路由由 Next 直接加载；lib/、components/、app/ 以外的文件（启动钩子、桌面壳、脚本）都算入口。
const isEntry = t => /^app\/(.*\/)?(page|layout|route|loading|error|not-found|global-error|template|default)\.tsx?$/.test(t)
  || !/^(lib|components|app)\//.test(t);
const dead = new Set();
for (let changed = true; changed;) {
  changed = false;
  for (const [t, users] of importers) {
    if (dead.has(t) || isEntry(t)) continue;
    if ([...users].filter(u => !u.startsWith('scripts/')).every(u => dead.has(u))) { dead.add(t); changed = true; }
  }
}
for (const t of [...dead].sort()) console.log(t);
```
