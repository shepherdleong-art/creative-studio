import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Exercise rendered download links, including replacement of the formal artifact.
// The media resolver binds both video and paired cover to the video artifact ID.
//
// 11 号票：卡片改成封面 + 大预览后，组件多了两个 UI 依赖（共用预览对话框与图标）。
// 这里只渲染静态 HTML（预览对话框 open=false 本来就返回 null），所以用最小桩解析别名，
// 断言原样保留：下载链接仍必须绑定同一个正式视频产物、带 download=1。
const realRequire = createRequire(import.meta.url);
const require = (id) => {
  if (id === '@/components/media/FilmPreviewDialog') return { FilmPreviewDialog: () => null };
  if (id === '@/components/ui/Icon') return { Icon: () => null };
  return realRequire(id);
};
const mod = { exports: {} };
const source = fs.readFileSync('components/batch-production/BatchStepExport.tsx', 'utf8');
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { require, module: mod, exports: mod.exports, URLSearchParams, window: { location: { assign: () => {} } } });

function downloads(formal) {
  const card = { planId: 'plan-1', seq: 1, versionNumber: 1, exportEligible: true,
    approved: true, exportStatus: 'exported', currentFormalArtifact: formal };
  const html = renderToStaticMarkup(React.createElement(mod.exports.default, {
    workspace: { cards: [card], counts: { total: 1, needsAttention: 0 }, exportDirName: '测试项目' },
    selectedPlanIds: [], phaseEBusy: null, folderRelativePath: null,
    projectId: 'project-1', selectedBatchId: 'batch-1', productCode: 'TEST',
  }));
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)]
    .map(([, href]) => new URL(href.replaceAll('&amp;', '&'), 'http://localhost'));
}

for (const generation of ['first', 'replacement']) {
  const videoId = `video-${generation}`;
  const links = downloads({ video: { id: videoId }, cover: { id: `cover-${generation}` } });
  assert.equal(links.length, 2);
  for (const kind of ['video', 'cover']) {
    const link = links.find(url => url.searchParams.get('kind') === kind);
    assert.ok(link, `${kind} download must be present`);
    assert.equal(link.pathname, '/api/batch-production/batches/batch-1/outputs/plan-1/media');
    assert.equal(link.searchParams.get('projectId'), 'project-1');
    assert.equal(link.searchParams.get('source'), 'artifact');
    assert.equal(link.searchParams.get('artifactId'), videoId, 'Both downloads must bind the same formal video generation');
    assert.equal(link.searchParams.get('download'), '1');
  }
}
assert.equal(downloads({ video: { id: 'video-only' }, cover: null }).length, 1);
assert.equal(downloads(null).length, 0);
console.log('Batch export download links: paired artifact identity and generation replacement passed.');
