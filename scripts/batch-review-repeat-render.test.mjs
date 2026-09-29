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
  console.log('batch review repeat rendering tests passed');
} finally {
  Module._resolveFilename = originalResolve;
  for (const [ext, loader] of Object.entries(originalLoaders)) {
    if (loader) Module._extensions[ext] = loader;
    else delete Module._extensions[ext];
  }
}
