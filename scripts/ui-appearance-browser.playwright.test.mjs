// 真实浏览器验证 02 号票的外观底座（Chromium + WebKit）：
//  1) 页面计算后的字号 / 字体族确实解析到打包字体（Inter + Lins Sans SC），不是「样式表里写了」；
//  2) 浅色与深色下关键区域的颜色来自新令牌（窗口底 / 内容区 / 正文），深色没有写死的浅色块；
//  3) 打开登录页只下载用到的中文字切片：给文件数与总字节数设上限；
//  4) 修改密码页（样板页）用上共用部件，浅深两色截图上没有横向溢出或控件被切。
// 需要先起一份隔离服务（与 team-acceptance-http 同样的环境变量），或直接用本机 dev。
// 用法：
//   UI_APPEARANCE_BASE_URL=http://127.0.0.1:3117 \
//   UI_APPEARANCE_EMPLOYEE_ID=demo-admin UI_APPEARANCE_PASSWORD=xxxx \
//   UI_APPEARANCE_EVIDENCE_DIR=I:/tmp/ui-evidence \
//   node scripts/ui-appearance-browser.playwright.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from '@playwright/test';

const baseUrl = process.env.UI_APPEARANCE_BASE_URL;
const employeeId = process.env.UI_APPEARANCE_EMPLOYEE_ID;
const password = process.env.UI_APPEARANCE_PASSWORD;
const evidenceDirectory = process.env.UI_APPEARANCE_EVIDENCE_DIR;
if (!baseUrl || !employeeId || !password || !evidenceDirectory) {
  throw new Error('浏览器验证需要 UI_APPEARANCE_BASE_URL / _EMPLOYEE_ID / _PASSWORD / _EVIDENCE_DIR');
}
fs.mkdirSync(evidenceDirectory, { recursive: true });

// 登录页上限：中文切片 ≤ 4 个文件、字体总计 ≤ 1.2 MB（整套中文字体约 2.1 MB）。
const LOGIN_FONT_FILE_LIMIT = 4;
const LOGIN_FONT_BYTE_LIMIT = 1_200_000;

const results = [];
function record(name, detail) {
  results.push({ name, ...detail });
}

// ── 登录页：只下载用到的切片 ──
for (const [name, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await launcher.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const fontResponses = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/fonts/') && url.pathname.endsWith('.woff2')) {
        const length = Number(response.headers()['content-length'] ?? 0);
        fontResponses.push({ path: url.pathname, status: response.status(), length });
      }
    });
    await page.goto(`${baseUrl}/team/login`, { waitUntil: 'networkidle', timeout: 90_000 });
    await page.evaluate(() => document.fonts.ready);

    // 1) 计算后的字体族：必须是打包字体在前，而不是系统字体。
    const computed = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const input = document.querySelector('input') ?? document.body;
      return {
        fontFamily: body.fontFamily,
        fontSize: body.fontSize,
        inputFontSize: getComputedStyle(input).fontSize,
      };
    });
    assert.match(computed.fontFamily, /Inter/, `${name}: 计算后字体族必须包含 Inter，实际 ${computed.fontFamily}`);
    assert.match(computed.fontFamily, /Lins Sans SC/, `${name}: 计算后字体族必须包含打包的中文字体`);
    assert.ok(computed.fontFamily.indexOf('Inter') < computed.fontFamily.indexOf('Lins Sans SC'),
      `${name}: 字体栈顺序必须是 Inter 在前`);
    assert.equal(computed.fontSize, '13.5px', `${name}: 正文必须是 13.5px，实际 ${computed.fontSize}`);
    assert.ok(parseFloat(computed.inputFontSize) >= 13, `${name}: 输入框字号不得小于 13px，实际 ${computed.inputFontSize}`);

    // 2) 实际渲染用的字体：document.fonts 里能用打包字体渲染中文与拉丁。
    const loaded = await page.evaluate(async () => {
      const status = (spec) => document.fonts.check(spec) ? 'loaded' : 'missing';
      await document.fonts.load('13.5px "Lins Sans SC"', '工号登录');
      await document.fonts.load('13.5px "Inter"', 'Creative Studio 2026');
      const faces = [...document.fonts].map((face) => ({ family: face.family.replace(/"/g, ''), status: face.status }));
      return {
        cjk: status('13.5px "Lins Sans SC"'),
        latin: status('13.5px "Inter"'),
        families: [...new Set(faces.map((face) => face.family))].sort(),
      };
    });
    assert.equal(loaded.cjk, 'loaded', `${name}: 打包中文字体必须真的加载可用`);
    assert.equal(loaded.latin, 'loaded', `${name}: Inter 必须真的加载可用`);
    assert.ok(loaded.families.includes('Inter') && loaded.families.includes('Lins Sans SC'),
      `${name}: document.fonts 里必须同时有 Inter 与 Lins Sans SC，实际 ${loaded.families.join(', ')}`);

    // 3) 切片下载上限：只下载用到的中文切片，不下载整套字体。
    const totalBytes = fontResponses.reduce((sum, item) => sum + item.length, 0);
    const cjkFiles = fontResponses.filter((item) => item.path.includes('lins-sans'));
    assert.ok(fontResponses.length > 0, `${name}: 登录页必须真的下载了打包字体文件`);
    assert.ok(fontResponses.every((item) => item.status === 200), `${name}: 字体文件请求必须全部成功`);
    assert.ok(cjkFiles.length <= LOGIN_FONT_FILE_LIMIT,
      `${name}: 登录页最多下载 ${LOGIN_FONT_FILE_LIMIT} 个中文切片，实际 ${cjkFiles.length}（${cjkFiles.map((f) => f.path).join(', ')}）`);
    assert.ok(totalBytes <= LOGIN_FONT_BYTE_LIMIT,
      `${name}: 登录页字体总字节不得超过 ${LOGIN_FONT_BYTE_LIMIT}，实际 ${totalBytes}`);
    record('login-fonts', { browser: name, files: fontResponses.length, cjkFiles: cjkFiles.length, totalBytes });

    // 4) 三档外观：浅色 / 深色 / 跟随系统都能切，且颜色来自令牌。
    await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded' });
    const themes = {};
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      themes[theme] = await page.evaluate(() => {
        const style = getComputedStyle(document.body);
        const root = getComputedStyle(document.documentElement);
        return {
          background: style.backgroundColor,
          color: style.color,
          contentToken: root.getPropertyValue('--color-content').trim(),
          windowToken: root.getPropertyValue('--color-window').trim(),
          inkToken: root.getPropertyValue('--color-ink').trim(),
        };
      });
      await page.screenshot({ path: path.join(evidenceDirectory, `login-${name}-${theme}.png`) });
    }
    // CSSOM 会把 #ffffff 规范化成 #fff，比较前先展开成 6 位。
    const expandHex = (value) => {
      const hex = value.trim().toLowerCase();
      const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
      return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : hex;
    };
    assert.equal(expandHex(themes.light.contentToken), '#ffffff', `${name}: 浅色内容区令牌应为 #ffffff`);
    assert.equal(expandHex(themes.dark.contentToken), '#1e1e20', `${name}: 深色内容区令牌应为 #1e1e20`);
    assert.equal(expandHex(themes.dark.windowToken), '#0e0e10', `${name}: 深色窗口底令牌应为 #0e0e10`);
    assert.equal(expandHex(themes.light.windowToken), '#e9e9ee', `${name}: 浅色窗口底令牌应为 #e9e9ee`);
    assert.notEqual(themes.light.background, themes.dark.background, `${name}: 深浅两色下页面底色必须不同`);
    assert.equal(themes.dark.background, 'rgb(30, 30, 32)', `${name}: 深色页面底色必须来自 --color-content（#1e1e20）`);
    record('themes', { browser: name, light: themes.light, dark: themes.dark });

    // 5) 修改密码页（样板页）：共用部件齐全，浅深两色都没有横向溢出或控件被切。
    //    账号可能还停在一一次性凭据状态（首登必须先改密）：先在页面里用同源 fetch
    //    把密码收敛到固定值，再用浏览器验证界面，这样脚本可重复运行。
    const stablePassword = `${password}-ui02`;
    await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded' });
    async function apiLogin(candidate) {
      return page.evaluate(async ({ employeeId, candidate }) => {
        const csrf = await fetch('/api/team/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
        const { csrfToken } = await csrf.json();
        const response = await fetch('/api/team/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ employeeId, password: candidate }),
        });
        const body = await response.json().catch(() => ({}));
        return { ok: response.ok, mustChangePassword: Boolean(body.mustChangePassword), message: body.message ?? '' };
      }, { employeeId, candidate });
    }
    async function apiChangePassword(currentPassword, newPassword) {
      return page.evaluate(async ({ currentPassword, newPassword }) => {
        const csrf = await fetch('/api/team/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
        const { csrfToken } = await csrf.json();
        const response = await fetch('/api/team/auth/change-password', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        return { ok: response.ok, status: response.status };
      }, { currentPassword, newPassword });
    }
    let accountPassword = password;
    let login = await apiLogin(accountPassword);
    if (login.ok && login.mustChangePassword) {
      const changed = await apiChangePassword(password, stablePassword);
      assert.equal(changed.ok, true, `${name}: 首次改密失败（HTTP ${changed.status}）`);
      accountPassword = stablePassword;
      login = await apiLogin(accountPassword);
    } else if (!login.ok) {
      accountPassword = stablePassword;
      login = await apiLogin(accountPassword);
    }
    assert.equal(login.ok, true, `${name}: 无法准备可用的测试账号密码（${login.message || '未知错误'}），请用 init-admin 生成一次性凭据后传入`);
    assert.equal(login.mustChangePassword, false, `${name}: 测试账号不应仍处于强制改密状态`);
    record('account-password', { browser: name, rotated: accountPassword !== password });
    // 上面的接口登录已经在浏览器上下文里种好会话，直接进修改密码页。
    const accountResponse = await page.goto(`${baseUrl}/team/account`, { waitUntil: 'networkidle', timeout: 90_000 });
    assert.equal(accountResponse?.ok(), true, `${name}: 修改密码页必须能打开`);
    assert.equal(page.url().includes('/team/login'), false, `${name}: 修改密码页不应被重定向回登录页`);
    // 共用部件必须真的出现在页面上。
    await page.getByRole('heading', { name: '修改密码' }).waitFor({ timeout: 30_000 });
    assert.ok(await page.locator('.page-toolbar').count() >= 1, `${name}: 必须用上页面工具栏部件`);
    assert.ok(await page.locator('.group-list .group-row').count() >= 3, `${name}: 必须用上分组列表部件`);
    assert.ok(await page.locator('.seg').count() >= 1, `${name}: 必须用上分段按钮部件`);
    assert.ok(await page.locator('.tag').count() >= 1, `${name}: 必须用上标签部件`);
    assert.ok(await page.locator('i[class^="status-dot-"]').count() >= 1, `${name}: 必须用上状态点部件`);

    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const layout = await page.evaluate(() => {
        const scrollWidth = document.documentElement.scrollWidth;
        const clientWidth = document.documentElement.clientWidth;
        const clipped = [...document.querySelectorAll('.group-row, .cap, .seg, .input-field')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && (rect.left < -0.5 || rect.right > window.innerWidth + 0.5);
          })
          .map((element) => `${element.className}:${Math.round(element.getBoundingClientRect().right)}`);
        const inputFontSizes = [...document.querySelectorAll('input')].map((element) => parseFloat(getComputedStyle(element).fontSize));
        const backgrounds = [...document.querySelectorAll('.group-list, .dialog-sheet')].map((element) => getComputedStyle(element).backgroundColor);
        return { scrollWidth, clientWidth, clipped, inputFontSizes, backgrounds };
      });
      assert.equal(layout.scrollWidth <= layout.clientWidth + 1, true, `${name}/${theme}: 修改密码页不得横向滚动`);
      assert.deepEqual(layout.clipped, [], `${name}/${theme}: 控件不得被切到视口外`);
      assert.ok(layout.inputFontSizes.every((size) => size >= 13), `${name}/${theme}: 输入框字号不得小于 13px`);
      await page.screenshot({ path: path.join(evidenceDirectory, `account-${name}-${theme}.png`), fullPage: true });
      record('account-layout', { browser: name, theme, ...layout });
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

fs.writeFileSync(path.join(evidenceDirectory, 'ui-appearance-result.json'), JSON.stringify({
  schemaVersion: 1,
  limits: { loginFontFileLimit: LOGIN_FONT_FILE_LIMIT, loginFontByteLimit: LOGIN_FONT_BYTE_LIMIT },
  results,
}, null, 2) + '\n');
console.log('PASS appearance tokens, bundled fonts, theme switching and account page layout (chromium + webkit)');
