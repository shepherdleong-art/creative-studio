import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from '@playwright/test';

const source = fs.readFileSync('components/packaging/sticker-bridge-callbacks.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const browser = await chromium.launch({ headless: true, executablePath: path.resolve('packaging/runtime/chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell') });
try {
  const page = await browser.newPage();
  await page.setContent('<iframe id="one" srcdoc="one"></iframe><iframe id="two" srcdoc="two"></iframe>');
  await page.addScriptTag({ content: `const exports={};${compiled}
    window.calls=[];window.currentFrame=document.querySelector('#one');
    window.detach=exports.installStickerBridgeCallbacks(window,()=>window.currentFrame,()=>({onStickerCommit:async(id)=>{window.calls.push(id);return true;}}));` });
  const result = await page.evaluate(async () => {
    const frame = window.currentFrame;
    window.oldWindow = frame.contentWindow;
    window.oldDocument = frame.contentDocument;
    const wrong = document.querySelector('#two');
    const invalid = await window.__packagingStickerEditCommit('wrong-frame', {}, wrong.contentWindow, wrong.contentDocument);
    const valid = await window.__packagingStickerEditCommit('current', {}, frame.contentWindow, frame.contentDocument);
    frame.srcdoc = 'reloaded';
    await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    const stale = await window.__packagingStickerEditCommit('old-document', {}, window.oldWindow, window.oldDocument);
    const fresh = await window.__packagingStickerEditCommit('fresh', {}, frame.contentWindow, frame.contentDocument);
    window.currentFrame = wrong;
    const switched = await window.__packagingStickerEditCommit('old-target', {}, frame.contentWindow, frame.contentDocument);
    window.detach();
    return { invalid, valid, stale, fresh, switched, calls: window.calls, cleaned: !window.__packagingStickerEditCommit };
  });
  assert.deepEqual(result, { invalid: false, valid: true, stale: false, fresh: true, switched: false, calls: ['current', 'fresh'], cleaned: true });
  console.log('贴纸回调真实 iframe 回归通过：错误窗口、同窗口旧文档、切换前目标均被拒绝。');
} finally { await browser.close(); }
