// Real template in a transparent iframe over media, under both host color schemes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { packagingPreviewHtml } from '../lib/media-core/packaging-preview.ts';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';

const compiled = ts.transpileModule(fs.readFileSync('components/packaging/PackagingOverlay.tsx', 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const overlayModule = { exports: {} };
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), overlayModule, overlayModule.exports);
const overlay = renderToStaticMarkup(React.createElement(overlayModule.exports.default, { src:'/overlay', timeSec:.4 }));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html style="color-scheme:${url.searchParams.get('theme')}"><head><style>iframe{width:100%;height:100%;border:0}</style></head><body style="margin:0"><div style="width:360px;height:480px;background:rgb(0,180,60)">${overlay}</div></body></html>`);
  } else if (url.pathname === '/overlay') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(packagingPreviewHtml({ config: { enabled: true, template: 'overlay-journal', varsOverrides: {} }, vars: { title: '测试', subtitle: '', point1: '', point2: '', point3: '' }, totalSec: 6, coverSec: 20/24 }));
  } else {
    const relative = decodeURIComponent(url.pathname).replace('/api/packaging/templates/', '');
    let file = path.resolve('packaging/templates', relative);
    if (!file.startsWith(path.resolve('packaging/templates') + path.sep)) { res.writeHead(404).end(); return; }
    if (!fs.existsSync(file) && relative.includes('/fonts/')) file = path.join('packaging/fonts', relative.split('/fonts/')[1]);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', { '.js':'text/javascript','.png':'image/png','.ttf':'font/ttf' }[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport:{width:360,height:480} });
  for (const theme of ['light', 'dark']) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    const frame = page.frames().find(f => f.url().endsWith('/overlay'));
    await frame.waitForFunction(() => !!window.__timelines?.overlay);
    for (const time of [.4, 2]) {
      await frame.evaluate(t => { window.__timelines.overlay.pause(); window.__timelines.overlay.seek(t); }, time);
      const { data } = await sharp(await page.screenshot()).extract({left:180,top:240,width:1,height:1}).removeAlpha().raw().toBuffer({resolveWithObject:true});
      console.log(theme, time, [...data]);
      assert.deepEqual([...data], [0,180,60], `${theme} preview must show media through the packaging window`);
    }
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
