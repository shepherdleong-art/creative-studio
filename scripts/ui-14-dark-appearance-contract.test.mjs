// 14 号票「只换外观」的静态契约：这些页面在深色下不得出现写死的浅色值。
//
// 为什么断言在源码上，而不是只靠浏览器截图：截图要人工看，回归靠不住；
// 而「深色下有没有白块」这件事的根因只有一类——组件里写死了浅色字面量
// （`#fff`、`bg-white`、`rgba(255,255,255,…)` 这类），或者用了不存在的
// `--color-*` 令牌（Tailwind 4 不会报错，只会静默渲染成透明/继承色）。
// 两条都是静态可断言的，所以这里就断这两条。
//
// 判据（按实际改法挑的落点）：
//   1. 本票改过的页面/组件里不得出现写死的浅色字面量：
//      `#fff` / `#ffffff` / `#FFF`、`bg-white` / `text-white` / `bg-black`、
//      `rgba(255,255,255,…)` / `rgba(0,0,0,…)` 直接当背景色/文字色用。
//      例外：`--color-media-background: #000000` 这类媒体底属于媒体控件语义，
//      不在本票的页面里；画布里 `rgba(0,0,0,.28)` 的缩略图遮罩是压在图片上的
//      半透明黑（浅深两态都需要），白字徽标同理，都在 ALLOWED 里逐条列出。
//   2. 组件里引用的 `var(--color-*)` 必须是 `app/globals.css` 里真实定义的令牌。
//      这条比第 1 条更重要：写错令牌名在浅色下常常「看着还行」（继承到墨色），
//      深色下才炸成透明/白字白底。
//   3. 外观入口不变：页面标题仍然由 nav 数据解析（`PageToolbar` 不传 title），
//      深色机制仍是 `html[data-theme='dark']`。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

/** 本票改过、并且要随深色切换的页面与组件（14 号票的完整范围）。 */
const OWNED_FILES = [
  // 页面入口
  'app/team/errors/page.tsx',
  'app/team/recycle-bin/page.tsx',
  'app/team/admin/users/page.tsx',
  'app/team/admin/resources/page.tsx',
  'app/team/admin/operations/page.tsx',
  'app/(workspace)/settings/page.tsx',
  'app/(workspace)/usage/page.tsx',
  'app/(workspace)/canvas/page.tsx',
  'app/(workspace)/canvas/[id]/page.tsx',
  // 团队面板
  'components/team/TeamErrorsPanel.tsx',
  'components/team/TeamRecycleBinPanel.tsx',
  'components/team/TeamUsersPanel.tsx',
  'components/team/TeamPublicResourcesPanel.tsx',
  'components/team/TeamMaintenancePanel.tsx',
  'components/team/TeamUsagePanel.tsx',
  'components/team/TeamBgmLibrary.tsx',
  'components/team/TeamCleanupPanel.tsx',
  'components/team/TeamRestorePanel.tsx',
  'components/team/TeamReleaseUpload.tsx',
  'components/team/TeamReleaseExecution.tsx',
  'components/team/TeamResourceCandidates.tsx',
  'components/team/TeamCredentialDialog.tsx',
  'components/team/useTeamRole.ts',
  'components/team/ClientDiagnostics.tsx',
  // 供应商与用量
  'components/ProviderSettings.tsx',
  'components/UsageDashboard.tsx',
  // 创作画布
  'components/creative-canvas/CanvasListPage.tsx',
  'components/creative-canvas/CanvasEditor.tsx',
  'components/creative-canvas/CanvasEdge.tsx',
  'components/creative-canvas/CanvasTaskDrawer.tsx',
  'components/creative-canvas/nodes.tsx',
  'components/creative-canvas/canvas-toasts.tsx',
  'components/creative-canvas/context-menu.tsx',
  'components/creative-canvas/DraftActions.tsx',
  'components/creative-canvas/AssetLightbox.tsx',
  'components/creative-canvas/CanvasThumbnail.tsx',
];
for (const file of OWNED_FILES) {
  assert.ok(fs.existsSync(path.join(root, file)), `14 号票的文件清单里出现不存在的文件：${file}`);
}

/**
 * 写死浅色字面量（按颜色出现位置判断，不看注释）。
 * 逐条列出允许的例外并写明原因——加例外要担责，不能整类放过。
 */
const LIGHT_LITERALS = [
  { pattern: /#fff(?:fff)?\b/i, label: '十六进制白' },
  { pattern: /\bbg-white\b/, label: 'bg-white' },
  { pattern: /\btext-white\b/, label: 'text-white' },
  { pattern: /\bbg-black\b/, label: 'bg-black' },
  { pattern: /\bborder-white\b/, label: 'border-white' },
  { pattern: /\brgba\(\s*255\s*,\s*255\s*,\s*255/, label: 'rgba(255,255,255,…)' },
  { pattern: /\brgb\(\s*255\s+255\s+255/, label: 'rgb(255 255 255)' },
];

/**
 * 允许的例外：压在媒体（图片/视频）上的半透明遮罩与白字徽标——它们必须
 * 在浅色下也是「黑遮罩 + 白字」，否则会随主题变成看不清的灰字。
 * 键是文件 + 该行的用途，值是该行出现次数上限之外的完整白名单。
 */
const ALLOWED = new Map([
  ['components/creative-canvas/canvas-toasts.tsx', { reason: 'toast 文案不涉及白色字面量（哨兵条目，实际无例外）', allow: () => false }],
]);

/** 注释行与被注释掉的代码不算界面颜色。 */
function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const offenders = [];
for (const file of OWNED_FILES) {
  const source = read(file);
  source.split('\n').forEach((line, index) => {
    if (isComment(line)) return;
    for (const { pattern, label } of LIGHT_LITERALS) {
      if (!pattern.test(line)) continue;
      const exception = ALLOWED.get(file);
      if (exception?.allow(line)) continue;
      offenders.push(`${file}:${index + 1} 出现写死浅色值（${label}）：${line.trim().slice(0, 120)}`);
    }
  });
}
assert.deepEqual(offenders, [], `深色下会出现写死的浅色块：\n${offenders.join('\n')}`);

/**
 * 令牌真实性：组件里引用的每个 `--color-*` 必须真的在 globals.css 里定义。
 * 只查 `--color-*`（语义色），其他 `--text-*` / `--radius-*` / `--font-*`
 * 同样在 globals.css 里，一起查——写错名字在深色下就是「透明块」。
 */
const globalsCss = read('app/globals.css');
const definedTokens = new Set([...globalsCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
const referenced = new Map();
for (const file of OWNED_FILES) {
  const source = read(file);
  for (const [, token] of source.matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (!referenced.has(token)) referenced.set(token, []);
    referenced.get(token).push(file);
  }
  // Tailwind 主题类（`text-ink`、`bg-group`…）解析到 `--color-*`；列出用到的前缀色名。
  for (const [, colorName] of source.matchAll(/(?:^|[\s"'`])(?:bg|text|border|ring|fill|stroke|outline|divide|from|to|via|accent)-([a-z][a-z0-9-]*)/g)) {
    const token = `--color-${colorName}`;
    // 只有确实在 globals.css `@theme` 里登记过的色名才当成令牌类；
    // `text-[12px]` 这类任意值、`text-left` 这类排版类会自然落到「未登记」分支。
    if (definedTokens.has(token)) continue;
    if (!LOOKS_LIKE_TOKEN_CLASS(colorName)) continue;
    referenced.set(`(类名) --color-${colorName}`, [...(referenced.get(`(类名) --color-${colorName}`) ?? []), file]);
  }
}
/** 只有形如语义令牌的色名才该在 @theme 里；`white`/`black`/`left`/`center` 这些不是。 */
function LOOKS_LIKE_TOKEN_CLASS(name) {
  return ['ink', 'surface', 'hairline', 'accent', 'run', 'ok', 'fail', 'warn', 'idle', 'check', 'window', 'content', 'sidebar', 'card', 'group', 'preview', 'zebra', 'track', 'seg', 'media', 'dot', 'review', 'success', 'danger', 'muted'].some(
    (prefix) => name === prefix || name.startsWith(`${prefix}-`),
  );
}
const missing = [];
for (const [token, files] of referenced) {
  if (!definedTokens.has(token.replace('(类名) ', ''))) missing.push(`${token}（${[...new Set(files)].join(', ')}）`);
}
assert.deepEqual(missing, [], `引用了 globals.css 里不存在的令牌，深色下会渲染成透明/继承色：\n${missing.join('\n')}`);

// ---- 外观入口不变：标题仍由导航数据解析，深色仍由 html[data-theme] 驱动 ----
const navigation = read('lib/workspace-navigation.ts');
assert.match(navigation, /export function workspacePageTitle/, '页面标题必须继续由导航数据解析（每页工具栏与导航名同源）');
for (const file of ['components/team/TeamErrorsPanel.tsx', 'components/team/TeamUsagePanel.tsx', 'components/team/TeamRecycleBinPanel.tsx']) {
  const source = read(file);
  assert.match(source, /<PageToolbar/, `${file} 必须挂每页工具栏（标题由外壳解析）`);
  assert.doesNotMatch(source, /<h1\b/, `${file} 挂上工具栏后不得再自带 <h1>（会出现两个大标题）`);
}
assert.match(globalsCss, /html\[data-theme='dark'\]/, '深色仍必须由 html[data-theme="dark"] 驱动');
// React Flow 段：深色下小地图遮罩与节点必须换成本地令牌，不能留着 React Flow 的浅色默认值。
assert.match(
  globalsCss,
  /html\[data-theme='dark'\]\s+\.react-flow__minimap-mask\s*\{[^}]*var\(--color-/,
  '深色下 React Flow 小地图遮罩必须引用设计令牌，否则会在深色小地图上铺一块浅色',
);
assert.match(
  globalsCss,
  /html\[data-theme='dark'\]\s+\.react-flow__minimap-node\s*\{[^}]*var\(--color-/,
  '深色下 React Flow 小地图节点必须引用设计令牌',
);

console.log(`PASS: 14 号票页面深色契约（${OWNED_FILES.length} 个文件、${referenced.size} 个令牌引用）`);
