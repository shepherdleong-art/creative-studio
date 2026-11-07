// 外观底座（02 号票）静态契约：
//  - 设计令牌：浅色 / 深色的关键取值必须来自规格，且深色只在 html[data-theme='dark'] 里覆盖；
//  - 字体打包：@font-face 与实际 woff2 文件一一对应，unicode-range 覆盖不重叠，
//    许可证随仓库发布；
//  - 打包链路：字体与许可证在 public/fonts/，因此会随 standalone 产物与免安装包一起发布。
// 断言的是「用户能看到的取值」与「文件真实存在」，不测类名或实现细节。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const globalsCss = fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8');
const fontsCss = fs.readFileSync(path.join(root, 'app', 'fonts.css'), 'utf8');
const slices = JSON.parse(fs.readFileSync(path.join(root, 'public', 'fonts', 'slices.json'), 'utf8'));

/** 取 @theme { ... } 里的浅色令牌。 */
function themeBlock(css) {
  const start = css.indexOf('@theme {');
  assert.ok(start >= 0, 'globals.css 必须有 @theme 块');
  const body = css.slice(start, css.indexOf('\n}', start));
  const tokens = new Map();
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(name, value.trim());
  return tokens;
}
/** 取 html[data-theme='dark'] 里的深色令牌。 */
function darkBlock(css) {
  const start = css.indexOf("html[data-theme='dark'] {");
  assert.ok(start >= 0, "globals.css 必须有 html[data-theme='dark'] 覆盖块");
  const body = css.slice(start, css.indexOf('\n}', start));
  const tokens = new Map();
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(name, value.trim());
  return tokens;
}

const light = themeBlock(globalsCss);
const dark = darkBlock(globalsCss);

// ── 浅色关键取值（规格「外观规范」）──
const lightExpectations = {
  '--color-window': '#e9e9ee',
  '--color-content': '#ffffff',
  '--color-surface': '#ffffff',
  '--color-sidebar': '#f7f7fa',
  '--color-group': '#f5f5f7',
  '--color-ink': '#1d1d1f',
  '--color-ink-secondary': '#5f5f64',
  '--color-accent': '#0071e3',
  '--color-ok': '#1c7a33',
  '--color-dot-ok': '#34c759',
  '--color-warn': '#9a5300',
  '--color-fail': '#c4001a',
};
for (const [name, expected] of Object.entries(lightExpectations)) {
  assert.ok(light.has(name), `缺少浅色令牌 ${name}`);
  assert.equal(light.get(name).toLowerCase(), expected, `浅色 ${name} 应为 ${expected}，实际 ${light.get(name)}`);
}
// 分隔线是 9% 透明度的黑色。
assert.equal(light.get('--color-hairline').replace(/\s+/g, ' ').toLowerCase(), 'rgb(0 0 0 / 9%)');

// ── 深色关键取值 ──
const darkExpectations = {
  '--color-window': '#0e0e10',
  '--color-content': '#1e1e20',
  '--color-card': '#2a2a2d',
  '--color-ink': '#f5f5f7',
  '--color-ink-secondary': '#aeaeb3',
  '--color-accent': '#0a72e0',
};
for (const [name, expected] of Object.entries(darkExpectations)) {
  assert.ok(dark.has(name), `缺少深色令牌 ${name}`);
  assert.equal(dark.get(name).toLowerCase(), expected, `深色 ${name} 应为 ${expected}，实际 ${dark.get(name)}`);
}
// 深色下状态色各自换亮一档：不能与浅色同值。
for (const name of ['--color-ok', '--color-fail', '--color-warn', '--color-dot-ok', '--color-dot-fail', '--color-dot-warn', '--color-dot-run']) {
  assert.ok(dark.has(name), `深色缺少状态色 ${name}`);
  assert.notEqual(dark.get(name).toLowerCase(), light.get(name).toLowerCase(), `深色 ${name} 必须换亮一档，不能与浅色同值`);
}

// ── 新增用途令牌齐全（窗口底 / 侧栏 / 内容区 / 卡片 / 分组底 / 预览区底 / 分段按钮）──
for (const name of [
  '--color-window', '--color-content', '--color-sidebar', '--color-card', '--color-group',
  '--color-preview', '--color-seg', '--color-seg-on', '--color-dot-run', '--color-dot-idle',
  '--text-body', '--text-label', '--text-input',
]) {
  assert.ok(light.has(name), `缺少新用途令牌 ${name}`);
}

// ── 字号与字体栈 ──
assert.equal(light.get('--text-body'), '13.5px', '正文必须是 13.5px');
assert.ok(parseFloat(light.get('--text-label')) >= 12, '标签和次要说明不得小于 12px');
assert.ok(parseFloat(light.get('--text-input')) >= 13, '输入框不得小于 13px');
const fontStack = light.get('--font-sans');
assert.ok(fontStack.startsWith('"Inter"'), `字体栈必须先是 Inter，实际 ${fontStack}`);
assert.ok(fontStack.indexOf('"Inter"') < fontStack.indexOf('"Lins Sans SC"'), '字体栈必须 Inter 在思源黑体之前');
assert.ok(fontStack.indexOf('"Lins Sans SC"') < fontStack.indexOf('"Microsoft YaHei"'), '思源黑体必须在微软雅黑之前');
assert.ok(fontStack.includes('"PingFang SC"'), '字体栈必须退化到苹方');

// 等宽数字：时长 / 金额 / 计数用 tabular-nums。
assert.match(globalsCss, /\.tnum\s*\{[^}]*font-variant-numeric:\s*tabular-nums/,
  'globals.css 必须提供 .tnum 工具类（tabular-nums）给时长 / 金额 / 计数使用');

// ── 外观机制保持不变 ──
assert.match(globalsCss, /html\[data-theme='dark'\]/, '深色仍由 html[data-theme="dark"] 驱动');
const layout = fs.readFileSync(path.join(root, 'app', 'layout.tsx'), 'utf8');
assert.match(layout, /localStorage\.getItem\('creative-studio-theme'\)/, 'localStorage 键必须仍是 creative-studio-theme');
const desktopTheme = fs.readFileSync(path.join(root, 'desktop', 'theme.ts'), 'utf8');
assert.match(desktopTheme, /nativeTheme\.themeSource = preference/, '桌面壳必须继续把外观偏好同步给原生控件主题');
for (const mode of ["'light'", "'dark'", "'system'"]) {
  assert.ok(desktopTheme.includes(mode), `桌面壳必须继续接受 ${mode} 三档偏好`);
}
const bridgeTypes = fs.readFileSync(path.join(root, 'desktop', 'bridge-types.ts'), 'utf8');
assert.match(bridgeTypes, /ThemePreference\s*=\s*'light'\s*\|\s*'dark'\s*\|\s*'system'/, '桌面壳的 ThemePreference 必须保持三档');
const toggle = fs.readFileSync(path.join(root, 'components', 'ThemeToggle.tsx'), 'utf8');
assert.match(toggle, /const STORAGE_KEY = 'creative-studio-theme'/, '切换按钮必须继续读写同一个存储键');
for (const mode of ['light', 'dark', 'system']) {
  assert.ok(toggle.includes(mode), `三档开关必须保留 ${mode} 档`);
}

// ── 字体：@font-face 与文件一一对应，unicode-range 覆盖不重叠 ──
const faceBlocks = [...fontsCss.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((match) => match[1]);
assert.ok(faceBlocks.length >= 2, '至少要有中文字体切片和 Inter 各一条 @font-face');
const declaredFiles = [];
const ranges = [];
for (const block of faceBlocks) {
  const family = /font-family:\s*"([^"]+)"/.exec(block)?.[1];
  const url = /url\("([^"]+)"\)/.exec(block)?.[1];
  const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
  assert.ok(family && url && range, `@font-face 必须带家族名、文件地址和 unicode-range：${block.slice(0, 80)}`);
  assert.ok(family === 'Inter' || family === 'Lins Sans SC', `意外的字体家族 ${family}`);
  const file = path.join(root, 'public', url.replace(/^\//, ''));
  assert.ok(fs.existsSync(file), `@font-face 引用的字体文件不存在：${url}`);
  assert.ok(fs.statSync(file).size > 1024, `字体切片 ${url} 太小，可能是空文件`);
  declaredFiles.push(url);
  for (const part of range.split(',')) {
    const [from, to] = part.trim().replace(/^U\+/i, '').split('-');
    ranges.push({ family, from: parseInt(from, 16), to: parseInt(to ?? from, 16), url });
  }
}
assert.equal(new Set(declaredFiles).size, declaredFiles.length, '同一个字体文件不得重复声明');
// 中文字体：所有切片之间不得有重叠码位（否则看起来「用了很多片」，实际是重复下载）。
const cjkRanges = ranges.filter((range) => range.family === 'Lins Sans SC').sort((a, b) => a.from - b.from);
assert.ok(cjkRanges.length >= 3, '中文字体必须切成多个按需下载的切片');
for (let index = 1; index < cjkRanges.length; index += 1) {
  assert.ok(
    cjkRanges[index].from > cjkRanges[index - 1].to,
    `中文字体切片 ${cjkRanges[index - 1].url} 与 ${cjkRanges[index].url} 的 unicode-range 重叠`,
  );
}
// 切片清单必须与实际文件一致（构建期不重新生成字体，靠这份清单验证）。
for (const slice of slices.slices) {
  const file = path.join(root, 'public', 'fonts', `${slice.name}.woff2`);
  assert.ok(fs.existsSync(file), `切片清单里的 ${slice.name} 没有对应文件`);
  assert.equal(fs.statSync(file).size, slice.bytes, `${slice.name} 字节数与 slices.json 不一致`);
}
assert.ok(slices.slices.length >= 3, '中文字体至少切 3 片');
assert.ok(slices.slices.length <= 12, '中文字体切片不能碎成一地小文件（最多 12 片）');

// 许可证必须随仓库发布，且覆盖两套字体。
const licenses = fs.readdirSync(path.join(root, 'public', 'fonts')).filter((name) => /^OFL-.*\.txt$/.test(name));
assert.ok(licenses.length >= 2, `public/fonts 必须同时放两套字体的 OFL 许可证，实际 ${licenses.join(', ') || '无'}`);
for (const license of licenses) {
  const text = fs.readFileSync(path.join(root, 'public', 'fonts', license), 'utf8');
  assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/i, `${license} 不是 SIL OFL 1.1 正文`);
}

// ── 构建期不联网取字体 ──
const layoutFiles = [globalsCss, fontsCss];
for (const content of layoutFiles) {
  assert.doesNotMatch(content, /fonts\.googleapis\.com|fonts\.gstatic\.com|https?:\/\/[^"')\s]+\.woff2/,
    '样式表里不得出现联网字体地址，字体必须来自 public/fonts/');
}

// ── 发布链路：standalone 与免安装包都要带上字体和许可证 ──
// standalone：sync-standalone-assets.mjs 整体拷贝 public/，字体在 public/fonts/ 下自动进产物；
// 该脚本的禁入清单来自 forbidden-paths.json（禁入而非白名单），不得包含 public 或 fonts。
const forbidden = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'packaging', 'forbidden-paths.json'), 'utf8'));
const forbiddenEntries = [...forbidden.core, ...forbidden.consumers.standaloneSyncPurge.extra];
for (const entry of forbiddenEntries) {
  assert.ok(!/^public/.test(entry), `禁入清单不得包含 public（会连带把字体挡在产物外）：${entry}`);
  assert.ok(!/font/i.test(entry), `禁入清单不得包含字体目录：${entry}`);
}
const sync = fs.readFileSync(path.join(root, 'scripts', 'sync-standalone-assets.mjs'), 'utf8');
assert.match(sync, /copyDirectory\(join\(root, 'public'\), join\(standaloneDir, 'public'\)\)/,
  'standalone 同步必须整体拷贝 public/，字体与许可证才能随产物发布');
// 免安装包：白名单整体拷贝 .next/standalone，字体随 standalone 一起进包。
const portable = fs.readFileSync(path.join(root, 'scripts', 'build-windows-portable.ps1'), 'utf8');
assert.match(portable, /Copy-PayloadDirectory \(Join-Path \$Root '\.next\\standalone'\)/,
  '免安装包必须整体拷贝 .next/standalone，字体与许可证才能随包发布');
assert.doesNotMatch(portable, /public\\?fonts/, '免安装包不应把 public/fonts 当成需要单独排除的目录');

console.log('PASS appearance tokens, font slices and packaging contract');
