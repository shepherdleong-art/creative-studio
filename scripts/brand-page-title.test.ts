// 页面标题按端区分：员工端「林视创作台」、管理员端「林视控制台」、
// 个人本地版与登录页用正式写法。
//
// 两段守护：
//   1. 标题决策函数（lib/brand.ts applicationTitle）逐端断言；
//   2. 根布局必须真的把身份交给它（generateMetadata），并且不能破坏首屏
//      外观脚本与 suppressHydrationWarning。
// 真正跑在浏览器里读 document.title 的部分在
// scripts/brand-login-page.playwright.test.mjs（管理员端与登录页两态）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_CONSOLE_TITLE,
  BRAND_NAME,
  EMPLOYEE_WORKSPACE_TITLE,
  applicationTitle,
} from '../lib/brand.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

// ---------- 1. 决策函数 ----------

assert.equal(applicationTitle(null, 'local'), BRAND_NAME, '个人本地版用正式写法');
assert.equal(applicationTitle({ role: 'employee' }, 'local'), BRAND_NAME, '本地版没有端名区分');
assert.equal(applicationTitle(null, 'server'), BRAND_NAME, '未登录（登录页）用正式写法，不能猜端点');
assert.equal(applicationTitle({ role: 'employee' }, 'server'), EMPLOYEE_WORKSPACE_TITLE, '员工端');
assert.equal(applicationTitle({ role: 'admin' }, 'server'), ADMIN_CONSOLE_TITLE, '管理员端');

// 三个标题互不相同，否则「按端区分」形同虚设。
assert.equal(new Set([BRAND_NAME, EMPLOYEE_WORKSPACE_TITLE, ADMIN_CONSOLE_TITLE]).size, 3);

// ---------- 2. 根布局接线 ----------

const layout = read('app/layout.tsx');

// 静态 metadata 拿不到身份，也就分不出两端：必须用 generateMetadata。
assert.doesNotMatch(layout, /export const metadata\b/, '根布局不得再导出静态 metadata');
assert.match(layout, /export async function generateMetadata/, '根布局必须用 generateMetadata 按端生成标题');
assert.match(layout, /applicationTitle\(/, '标题必须来自 lib/brand.ts 的 applicationTitle');
assert.match(layout, /readRuntimeConfig\(\)/, '标题必须按运行时模式（local/server）决定');
assert.match(layout, /TEAM_SESSION_COOKIE/, '团队版必须按会话解析身份');
assert.match(layout, /resolved\.role/, '必须把身份角色交给标题决策');

// 身份结构不可用时不能把页面拖挂：generateMetadata 里必须兜住异常。
const metadataStart = layout.indexOf('export async function generateMetadata');
const metadataBody = layout.slice(metadataStart, layout.indexOf('\n}\n', metadataStart));
assert.match(metadataBody, /try \{[\s\S]*?\} catch \{/, '身份结构不可用时必须降级而不是抛错');

// 改标题不许破坏首屏外观脚本与水合抑制。
assert.match(layout, /suppressHydrationWarning/, '必须保留 suppressHydrationWarning');
assert.match(layout, /localStorage\.getItem\('creative-studio-theme'\)/, '必须保留首屏外观脚本');
assert.match(
  layout,
  /dangerouslySetInnerHTML=\{\{ __html: themeInitScript \}\}/,
  '首屏外观脚本必须仍在 HTML 里内联执行',
);
assert.match(layout, /<html lang="zh-CN"/, '根 <html> 不得被改动');

// 图标仍指向新标志的产物。
assert.match(layout, /url: "\/favicon\.ico"/);
assert.match(layout, /url: "\/icons\/app-icon\.svg"/);
assert.match(layout, /url: "\/apple-icon\.png"/);

console.log('page title per-端 tests passed');
