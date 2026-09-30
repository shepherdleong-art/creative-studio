import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// 渲染真实 React 时间线，不启动应用、不连接用户数据库。
const require = createRequire(import.meta.url);
const originalResolve = Module._resolveFilename;
const originalLoaders = Object.fromEntries(['.ts', '.tsx', '.css'].map(ext => [ext, Module._extensions[ext]]));
Module._resolveFilename = function(request, ...args) {
  return originalResolve.call(this, request.startsWith('@/') ? path.resolve(request.slice(2)) : request, ...args);
};
for (const ext of ['.ts', '.tsx']) {
  Module._extensions[ext] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
}
Module._extensions['.css'] = mod => {
  mod.exports = { __esModule: true, default: new Proxy({}, { get: (_target, key) => key }) };
};

try {
  const Timeline = require('../components/batch-production/review/BatchReviewTimelineDock.tsx').default;
  const clip = (clipId, assetId, sourceStartUs, sourceEndUs, timelineStartUs) => ({
    clipId, assetId, sourceStartUs, sourceEndUs, timelineStartUs,
    timelineEndUs: timelineStartUs + sourceEndUs - sourceStartUs, locked: false,
  });
  const film = clips => ({
    planId: 'one', seq: 1, scriptTitle: '测试成片', status: 'reviewable', approved: false,
    approvable: true, visible: true, durationSec: 8, warnings: [], blockers: [],
    arrangement: { clips, narration: { durationUs: 8_000_000 }, subtitleCues: [], music: { trackId: null }, musicLibrary: [] },
  });
  const props = {
    projectId: 'project', batchId: 'batch', selectedPlanId: null, selection: null, focusedAssetId: null,
    playheadSec: 0, tool: 'select', snapEnabled: true, canUndo: false, canRedo: false,
    poolAssets: [], selectedPlanIds: [], rowFilter: 'all', batchControlState: 'stopped', phaseEBusy: null,
  };
  for (const name of ['onSelectFilm', 'onSelectTarget', 'onSelectFocusedAsset', 'onSeek', 'onToolChange',
    'onToggleSnap', 'onUndo', 'onRedo', 'onToggleEye', 'onTogglePlanSelect', 'onSelectAll', 'onReview',
    'onRowFilterChange', 'onShowAll', 'onReallocate', 'onRetryNarration', 'onRetryRender', 'onMediaEdit',
    'onRefreshFilm', 'onOpenCoverEditor']) props[name] = () => {};
  const render = (films, extra = {}) => renderToStaticMarkup(React.createElement(Timeline, { ...props, films, ...extra }));
  const splitClips = [clip('first', 'video', 0, 2_000_000, 0), clip('second', 'video', 2_000_000, 4_000_000, 2_000_000)];
  const initial = render([film(splitClips)]);
  assert.equal((initial.match(/同一素材 ×2/g) ?? []).length, 2, '未选中任何片段时，两段都显示复用提醒');
  assert.match(initial, /重复检查：1 个素材被用于 2 个片段/);
  assert.doesNotMatch(initial, /class="clipOverlap"/, '纯分割不误画源区间重叠斜纹');
  const filtered = render([film(splitClips)], { rowFilter: 'overlap' });
  assert.equal((filtered.match(/同一素材 ×2/g) ?? []).length, 2);
  assert.doesNotMatch(filtered, /clipDim/, '区间重复检查保留同一视频拆开的各段');
  const overlapping = render([film([splitClips[0], clip('second', 'video', 1_000_000, 3_000_000, 2_000_000)])]);
  assert.equal((overlapping.match(/区间重叠 ×2/g) ?? []).length, 2, '同片内真正重叠无需点击即可提示');
  assert.equal((overlapping.match(/class="clipOverlap"/g) ?? []).length, 2);
  const selected = render([film([splitClips[0], clip('second', 'video', 1_000_000, 3_000_000, 2_000_000)])], {
    selectedPlanId: 'one', selection: { kind: 'clip', planId: 'one', clipId: 'first' },
  });
  assert.equal((selected.match(/区间重叠 ×2/g) ?? []).length, 2, '选中片段自身也保留提醒和斜纹');
  const single = render([film([splitClips[0]])]);
  assert.doesNotMatch(single, /同一素材 ×|区间重叠 ×|重复检查：/);
  const sourceFilm = { ...film([
    clip('first', 'v1', 0, 2_000_000, 0), clip('second', 'v2', 0, 2_000_000, 2_000_000),
    clip('third', 'unrelated', 0, 2_000_000, 4_000_000),
  ]), sourceConflictAssetIds: ['v1', 'v2'] };
  for (const extra of [{}, { rowFilter: 'overlap' }, {
    rowFilter: 'overlap', focusedAssetId: 'unrelated', selectedPlanId: 'one',
    selection: { kind: 'clip', planId: 'one', clipId: 'first' },
  }]) {
    const markup = render([sourceFilm], extra);
    assert.equal((markup.match(/class="[^"]*clipSourceConflict/g) ?? []).length, 2, '同源的两个不同视频都高亮，定位其他素材或选中时仍保留');
    assert.equal((markup.match(/>同源图<\/span>/g) ?? []).length, 2);
    assert.match(markup, /同源图检查：1 条成片中的 2 个片段/);
    assert.doesNotMatch(markup, /class="clipOverlap"/, '同源不同视频不能误画为源区间重叠');
    assert.equal((markup.match(/clipDim/g) ?? []).length, extra.rowFilter === 'overlap' ? 1 : 0, '重复筛选仅调暗无关素材');
  }
  const sourceCleared = render([{ ...sourceFilm, arrangement: { ...sourceFilm.arrangement, sourceConflictAssetIds: [] } }]);
  assert.doesNotMatch(sourceCleared, /clipSourceConflict|同源图检查：/, '局部编辑解除同源后清除高亮');
  const distinctGroups = render([
    film([clip('a1', 'asset-a', 0, 2_000_000, 0), clip('b1', 'asset-b', 0, 2_000_000, 2_000_000)]),
    { ...film([clip('b2', 'asset-b', 2_000_000, 4_000_000, 0), clip('a2', 'asset-a', 2_000_000, 4_000_000, 2_000_000)]), planId: 'two' },
  ], { focusedAssetId: 'asset-a', rowFilter: 'overlap', selectedPlanId: 'one', selection: { kind: 'clip', planId: 'one', clipId: 'a1' } });
  assert.equal((distinctGroups.match(/class="usageGroupLabel">A<\/b>/g) ?? []).length, 2);
  assert.equal((distinctGroups.match(/class="usageGroupLabel">B<\/b>/g) ?? []).length, 2);
  assert.equal((distinctGroups.match(/class="[^"]*clipRepeat /g) ?? []).length, 4, '定位 A 不会撤掉 B 的色块，选中 A 也保留');
  assert.match(distinctGroups, /--usage-color:var\(--color-review-1\)/);
  assert.match(distinctGroups, /--usage-color:var\(--color-review-2\)/);
  const sourceGrouped = render([{ ...sourceFilm, sourceConflictGroups: [{ key: 'original-image', assetIds: ['v1', 'v2'] }] }]);
  assert.equal((sourceGrouped.match(/class="usageGroupLabel">S1<\/b>/g) ?? []).length, 2);
  // 色号由运行时身份决定，Tailwind 不可把没有静态 utility 引用的浅色令牌裁掉。
  const globalCss = fs.readFileSync('app/globals.css', 'utf8').replace('@import "tailwindcss";', '@import "tailwindcss" source(none);');
  const compiled = await require('postcss')([require('@tailwindcss/postcss')()]).process(globalCss, { from: path.resolve('app/globals.css') });
  const rootTokens = new Set();
  compiled.root.walkRules(rule => {
    if (rule.selector.includes(':root')) rule.walkDecls(decl => rootTokens.add(decl.prop));
  });
  for (let i = 1; i <= 8; i++) {
    assert.ok(rootTokens.has(`--color-review-${i}`), '动态分组颜色必须保留到编译后的全局样式');
    assert.ok(rootTokens.has(`--color-review-${i}-tint`));
  }
  console.log('batch review repeat rendering tests passed');
} finally {
  Module._resolveFilename = originalResolve;
  for (const [ext, loader] of Object.entries(originalLoaders)) {
    if (loader) Module._extensions[ext] = loader;
    else delete Module._extensions[ext];
  }
}
