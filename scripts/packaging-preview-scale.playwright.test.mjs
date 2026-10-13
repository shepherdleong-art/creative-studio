// Run: node scripts/packaging-preview-scale.playwright.test.mjs
// Real preview HTML, templates and fonts; isolated from app services and user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { packagingPreviewHtml } from '../lib/media-core/packaging-preview.ts';

const root = process.cwd();
const vars = { title: '舒适重卷沙发', subtitle: '洁净省心', point1: '2.82m', point2: '107°松腰', point3: '拟鲨鳍撞设计' };
const templates = ['overlay-poster', 'overlay-journal', 'overlay-minimal', 'overlay-variety'];
const layout = { x: 48, y: 25, scale: 1.15, rotate: 5 };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const template = url.searchParams.get('template') || templates[0];
    res.end(packagingPreviewHtml({
      config: { enabled: true, template, varsOverrides: {}, pointCues: [{ id: 'test', text: '宽敞舒适好打理', startSec: 1, endSec: 4 }], pointCuesMode: 'timed',
        ...(url.searchParams.has('custom') ? { layouts: { [template]: { cover: { title: layout, subtitle: { ...layout, y: 42, scale: .85 }, point2: { ...layout, y: 70 } }, cues: { test: layout } } } } : {}),
      },
      vars, totalSec: 18.4, coverSec: 20 / 24, edit: true,
    }));
    return;
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/api\/packaging\/templates\//, '');
  let file = path.resolve(root, 'packaging/templates', relative);
  if (!file.startsWith(path.join(root, 'packaging/templates') + path.sep)) { res.writeHead(404).end(); return; }
  if (!fs.existsSync(file) && relative.includes('/fonts/')) file = path.join(root, 'packaging/fonts', relative.split('/fonts/')[1]);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404).end(); return; }
  const mime = { '.js': 'text/javascript', '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png' };
  res.setHeader('Content-Type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 360, height: 480 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function sample(width, time = .4) {
    await page.setViewportSize({ width, height: width * 4 / 3 });
    await page.evaluate(async time => {
      window.__editMode = { active: true, only: null };
      await document.fonts.ready;
      window.__timelines.overlay.pause();
      window.__timelines.overlay.seek(time);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, time);
    return page.evaluate(time => {
      const root = document.querySelector('#root').getBoundingClientRect();
      return Object.fromEntries([...document.querySelectorAll(time < 1 ? '[data-point-id^="cover:"]' : '[data-point-id^="cue:"]')].map(el => {
        const rect = el.getBoundingClientRect(), css = getComputedStyle(el.querySelector('.ptxt, .txt') || el);
        return [el.dataset.pointId, { font: parseFloat(css.fontSize) / root.width, x: (rect.x - root.x) / root.width, y: (rect.y - root.y) / root.height, width: rect.width / root.width, height: rect.height / root.height }];
      }));
    }, time);
  }
  const failures = [];
  function compare(label, baseline, result) {
    for (const [id, before] of Object.entries(baseline)) {
      for (const field of Object.keys(before)) {
        const delta = Math.abs(before[field] - result[id][field]);
        // Font rasterization rounds line boxes at small sizes; the proportional geometry stays within 0.8%.
        if (delta > .008) failures.push(`${label} ${id}.${field}: ${before[field].toFixed(4)} -> ${result[id][field].toFixed(4)}`);
      }
    }
  }
  for (const template of templates) {
    for (const custom of [false, true]) {
    await page.setViewportSize({ width: 360, height: 480 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?template=${template}${custom ? '&custom' : ''}`);
    await page.waitForFunction(() => !!window.__timelines?.overlay);
    for (const time of [.4, 2]) {
      const baseline = await sample(360, time);
      for (const width of [180, 720, 1080, 360]) {
        compare(`${template} custom=${custom} time=${time} width=${width}`, baseline, await sample(width, time));
      }
    }
    console.log(`${template} ${custom ? 'saved layouts' : 'default layouts'}: checked cover + body at 180/360/720/1080px`);
    }
  }
  assert.deepEqual(errors, [], 'preview has no browser errors');
  assert.deepEqual(failures, [], 'cover typography and layout must scale proportionally with the preview');
  console.log('Packaging cover scale invariance passed for all four templates.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
