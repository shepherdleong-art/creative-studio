// 品牌改名守护：对外显示名可以换，内部标识（包名、数据目录、环境变量、
// 浏览器存储键、会话 Cookie、IPC 通道、桌面可执行名）一个都不能动——
// 改了会让老用户升级后丢登录状态、丢外观偏好或读不到自己的数据。
//
// 断言里的期望值都是固定的字面量，绝不从被检查实现里反推，否则守护就失效了。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_CONSOLE_TITLE,
  BRAND_ATTRIBUTION,
  BRAND_CLAIM,
  BRAND_NAME,
  BRAND_SUBTITLE,
  EMPLOYEE_WORKSPACE_TITLE,
  applicationTitle,
} from '../lib/brand.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

// ---------- 对外显示名（三端标题 + 正式写法） ----------

assert.equal(BRAND_NAME, "林视 Lin's Vision");
assert.equal(BRAND_SUBTITLE, 'AI 产品图与短视频创作工作台');
assert.equal(EMPLOYEE_WORKSPACE_TITLE, '林视创作台');
assert.equal(ADMIN_CONSOLE_TITLE, '林视控制台');
assert.equal(BRAND_CLAIM, '出片交给 AI，眼光留给你。');
assert.equal(BRAND_ATTRIBUTION, "© 林视 Lin's Vision");

assert.equal(applicationTitle(null, 'local'), "林视 Lin's Vision", '个人本地版用正式写法');
assert.equal(applicationTitle(null, 'server'), "林视 Lin's Vision", '未登录（登录页）用正式写法');
assert.equal(applicationTitle({ role: 'employee' }, 'server'), '林视创作台', '员工端标题');
assert.equal(applicationTitle({ role: 'admin' }, 'server'), '林视控制台', '管理员端标题');

// ---------- 应用数据目录名 ----------

const main = read('desktop/main.ts');
const remoteHost = read('desktop/client/remote-host.ts');

assert.match(
  main,
  /app\.getPath\('appData'\), 'CreativeStudio'\)/,
  '安装版数据根目录名必须是 CreativeStudio，改了就找不到旧数据',
);
assert.match(
  remoteHost,
  /path\.join\(app\.getPath\('appData'\), 'CreativeStudioClient'\)/,
  '轻客户端状态目录名必须是 CreativeStudioClient',
);
// 桌面壳不得按显示名推导数据目录：数据根那一行只能出现固定目录名。
const dataRootLine = main.split('\n').find((line) => line.includes("app.getPath('appData')"))
  ?? '';
assert.ok(dataRootLine.length > 0, '找不到安装版数据根解析');
assert.doesNotMatch(dataRootLine, /林视/, '数据根解析不得依赖显示名');

// ---------- 外观偏好与记住登录的浏览器存储键 ----------

const layout = read('app/layout.tsx');
const themeToggle = read('components/ThemeToggle.tsx');
const loginForm = read('components/team/TeamLoginForm.tsx');
const mixcutShell = read('components/mixcut/MixcutShell.tsx');

assert.match(layout, /localStorage\.getItem\('creative-studio-theme'\)/, '首屏外观脚本的键不能改');
assert.match(themeToggle, /const STORAGE_KEY = 'creative-studio-theme';/, '外观存储键必须与首屏脚本一致');
assert.equal(
  [...themeToggle.matchAll(/creative-studio-theme/g)].length,
  1,
  '外观存储键应只在 ThemeToggle 里出现一次，避免两份字面量漂移',
);
assert.match(loginForm, /'creative-studio-remember-login'/, '记住登录的键不能改');
assert.equal([...mixcutShell.matchAll(/mixcut-layout-v2/g)].length, 2, '混剪布局存储键不能改');

// ---------- 会话 Cookie 名 ----------

const request = read('lib/team-service/auth/request.ts');

assert.match(request, /__Host-team_session/, '会话 Cookie 名不能改');
assert.match(request, /__Host-team_csrf/, 'CSRF Cookie 名不能改');
assert.match(request, /creative_studio_team_session_local/, 'local-team 会话 Cookie 名不能改');
assert.match(request, /creative_studio_team_csrf_local/, 'local-team CSRF Cookie 名不能改');

// ---------- 包名与桌面可执行名 ----------

const packageJson = JSON.parse(read('package.json')) as { name: string };
assert.equal(packageJson.name, 'creative-studio', '包名不能改');

// ---------- IPC 通道名（渲染层与主进程的私有契约） ----------

const ipc = read('desktop/ipc.ts');
const expectedChannels = [
  'desktop:platform',
  'desktop:choose-media-files',
  'desktop:choose-folder',
  'desktop:get-app-version',
  'desktop:relocate-linked-source',
  'desktop:open-folder',
  'desktop:reveal-item',
  'desktop:linked-import-progress',
  'desktop:set-theme-preference',
  'desktop:quit-requested',
  'desktop:client-choose-upload-files',
  'desktop:client-pause-transfer',
  'desktop:client-resume-transfer',
  'desktop:client-cancel-transfer',
  'desktop:client-reveal-download',
  'desktop:client-get-status',
  'desktop:client-install-update',
  'desktop:client-report-error',
] as const;
for (const channel of expectedChannels) {
  assert.ok(ipc.includes(`'${channel}'`), `IPC 通道名被改动或删除：${channel}`);
}

// ---------- 桌面壳的显示名字面量与 lib/brand.ts 同源 ----------

// desktop/ 是纯壳边界，不能 import lib/，显示名只能写字面量；
// 这里守住两份字面量不漂移。
assert.ok(
  read('desktop/window.ts').includes(BRAND_NAME),
  `桌面壳启动画面必须出现正式写法 ${BRAND_NAME}`,
);
assert.ok(
  read('desktop/main.ts').includes(BRAND_NAME),
  `桌面壳启动失败提示必须出现正式写法 ${BRAND_NAME}`,
);
assert.ok(
  read('desktop/client/remote-transfer.ts').includes(`${BRAND_NAME} 轻客户端`),
  '轻客户端显示名必须用正式写法',
);

console.log('brand identity guard tests passed');
