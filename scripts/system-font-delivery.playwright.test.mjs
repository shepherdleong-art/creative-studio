// Real server-only font bytes -> browser FontFace -> Canvas. No user DB or OS installation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import ts from 'typescript';
import { chromium } from 'playwright';

const loader = ts.transpileModule(fs.readFileSync('components/system-fonts.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replace(/\bexport\s+/g, '');
const fontBytes = fs.readFileSync('packaging/fonts/ZCOOLKuaiLe-Regular.ttf');
const fontUrl = `/api/system-fonts/${'a'.repeat(64)}/file`;
let fileRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url === fontUrl) { fileRequests++; res.writeHead(200, { 'Content-Type': 'font/ttf' }); res.end(fontBytes); }
  else if (req.url === '/api/system-fonts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ fonts: [{ family: 'Server Only Regression', displayName: '服务器专用字体', previewUrl: fontUrl }] }));
  } else if (req.url === '/loader.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(loader); }
  else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<script src="/loader.js"></script><canvas></canvas>'); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    document.documentElement.dataset.deploymentMode = 'server';
    let localQueries = 0;
    window.queryLocalFonts = async () => { localQueries++; return [{ family: 'Client Only Font' }]; };
    const options = await requestFontOptions();
    const ctx = document.querySelector('canvas').getContext('2d');
    const sample = '这是服务器上的中文字体';
    ctx.font = '48px "Server Only Regression", monospace';
    const before = ctx.measureText(sample).width;
    await Promise.all([ensureServerFontLoaded('Server Only Regression'), ensureServerFontLoaded('Server Only Regression')]);
    ctx.font = '48px "Server Only Regression", monospace';
    return { before, after: ctx.measureText(sample).width, loaded: document.fonts.check('48px "Server Only Regression"'), localQueries, families: options.map(font => font.family) };
  });
  assert.equal(result.loaded, true);
  assert.equal(result.localQueries, 0, '团队客户端必须读取服务器目录，不枚举本机字体');
  assert.deepEqual(result.families, ['Server Only Regression']);
  assert.notEqual(result.after, result.before, '客户端未安装的服务器字体必须实际改变 Canvas 字形度量');
  assert.equal(fileRequests, 1, '并发加载同一字体必须复用请求');
  console.log('server-only font loads and changes browser Canvas rendering');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
