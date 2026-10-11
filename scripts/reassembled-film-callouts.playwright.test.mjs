// Local browser validation of the packaging CLI. No providers, app server or production media.
// node scripts/reassembled-film-callouts.playwright.test.mjs [optional preview output directory]
// PYTHON must point to Python 3.11+; assets use the installed product-film skill by default.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-callout-browser-'));
const python = process.env.PYTHON || 'python3';
const assets = process.env.PRODUCT_FILM_ASSETS || path.join(os.homedir(), '.codex/skills/product-film/templates/hf');
const preview = process.argv[2] ? path.resolve(process.argv[2]) : null;
let browser;
try {
  execFileSync(python, ['-c', 'import runpy,sys; from pathlib import Path; runpy.run_path(sys.argv[1],run_name="fixture")["fixture"](Path(sys.argv[2]))',
    path.resolve('scripts/reassembled-film-packaging.test.py'), root]);
  execFileSync(python, ['scripts/reassembled-film/packaging.py', root, '01', '--assets', assets, '--output', path.join(root, 'hf')]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(root, 'hf/index.html')).href);
  await page.evaluate(async () => { await document.fonts.load('36px RFCallout'); await document.fonts.ready; });
  assert.equal(await page.evaluate(() => document.fonts.check('36px RFCallout')), true);
  // A schematic backdrop makes this a packaging preview, not product/film evidence.
  await page.addStyleTag({ content: `body{margin:0}#root{position:relative;width:1080px;height:1440px;background:#c6b29d}
    video{display:none}.rf-callout-pill{--rf-callout-bg:rgba(57,39,26,.78)}
    .fixture-note{position:absolute;left:70px;top:65px;font:24px RFCallout;color:#473b30}
    .fixture-sub{position:absolute;left:0;right:0;bottom:235px;text-align:center;font:36px RFCallout;color:#fff8ed}` });
  await page.evaluate(() => {
    document.querySelector('#root').insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 1080 1440" style="position:absolute;inset:0;width:100%;height:100%">
      <defs><linearGradient id="cushion" x2="1" y2="1"><stop stop-color="#b68b62"/><stop offset="1" stop-color="#8d6545"/></linearGradient></defs>
      <rect width="1080" height="1440" fill="#c6b29d"/><rect y="1060" width="1080" height="380" fill="#ae9a82"/>
      <rect x="170" y="440" width="740" height="590" rx="120" fill="url(#cushion)"/>
      <rect x="240" y="505" width="600" height="240" rx="70" fill="#c6a27e"/>
      <rect x="240" y="745" width="600" height="195" rx="65" fill="#ac8059"/>
      <rect x="160" y="890" width="760" height="230" rx="70" fill="#b68b62"/>
      <path d="M240 740H840M220 1090H860" stroke="#805b3e" stroke-width="5" opacity=".4"/>
    </svg><div class="fixture-note">本地包装验证 · 示意背景 · 非成片</div><div class="fixture-sub">头颈 被托住了</div>`);
  });
  const seek = async (time) => {
    await page.evaluate((at) => {
      window.__timelines.main.pause().seek(at, false);
      // Simulate HyperFrames clip windows; GSAP animates content inside those windows.
      for (const clip of document.querySelectorAll('.clip')) {
        const start = Number(clip.dataset.start);
        clip.style.visibility = at >= start && at < start + Number(clip.dataset.duration) ? 'visible' : 'hidden';
      }
    }, time);
  };
  const geometry = () => page.evaluate(() => {
    const dot = document.querySelector('#rf-callout-back-dot');
    const line = document.querySelector('#rf-callout-back-line');
    const card = document.querySelector('#rf-callout-back-pill');
    return { x: Number(dot.getAttribute('cx')), y: Number(dot.getAttribute('cy')),
      lx: Number(line.getAttribute('x1')), ly: Number(line.getAttribute('y1')),
      opacity: Number(getComputedStyle(document.querySelector('#rf-callout-back-content')).opacity),
      cardOpacity: Number(getComputedStyle(card).opacity),
      visibility: getComputedStyle(card).visibility,
      overflow: card.scrollHeight > card.clientHeight || card.scrollWidth > card.clientWidth };
  });
  await seek(6.5);
  let g = await geometry();
  const expected = 430 + 50 * (6.5 - 5) / (71 / 24);
  assert.ok(Math.abs(g.x - expected) < .02, 'marker follows interpolated final-frame coordinates');
  assert.ok(Math.abs(g.lx - g.x) < .001 && Math.abs(g.ly - g.y) < .001, 'leader stays attached to marker');
  assert.equal(g.overflow, false, 'card text fits the chosen box with the real font');
  assert.equal(g.cardOpacity, 1);
  if (preview) {
    fs.mkdirSync(preview, { recursive: true });
    await page.screenshot({ path: path.join(preview, '卖点标注预览.png') });
  }
  await seek(5.5); // Seek backwards: required for deterministic frame rendering.
  g = await geometry();
  assert.ok(Math.abs(g.x - (430 + 50 * .5 / (71 / 24))) < .02, 'tracking survives backward seeks');
  await seek(7.98);
  assert.ok((await geometry()).opacity < .11, 'annotation exits before its end frame');
  await seek(8);
  assert.equal((await geometry()).visibility, 'hidden');
  await seek(4.9);
  assert.equal((await geometry()).visibility, 'hidden');
  await seek(0);
  assert.equal((await geometry()).visibility, 'hidden', 'cover has no annotation');
  assert.deepEqual(errors, []);
  console.log('Callout browser checks passed: font, layout, tracking, backward seek, exit and cover.');
} finally {
  await browser?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
