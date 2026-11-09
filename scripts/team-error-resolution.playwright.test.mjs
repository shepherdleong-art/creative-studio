// 隔离服务 + 正式 API：验证首页/错误中心的处理按钮、持久化和诊断保留，同时运行尺寸验收。
// Windows 运行前按 docs/reference/界面尺寸验收.md 设置仓库外的 TEMP/TMP。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SCREENS } from './team-server/ui-acceptance-screens.mjs';

process.env.TEAM_ACCEPTANCE_UI_SCREENS = 'home,errors';
process.env.TEAM_ACCEPTANCE_BROWSER_EVIDENCE_DIR ??= 'outputs/team-error-resolution-ui';
const records = new WeakMap();

async function reportError(page) {
  const eventId = randomUUID();
  return page.evaluate(async (clientEventId) => {
    const csrf = await (await fetch('/api/team/auth/csrf')).json();
    const response = await fetch('/api/team/errors/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf.csrfToken },
      body: JSON.stringify({ clientEventId, stage: 'client_ui', code: 'resolution_browser_fixture' }),
    });
    if (!response.ok) throw new Error(`fixture report: ${response.status}`);
    return response.json();
  }, eventId);
}

for (const screen of SCREENS.filter(({ id }) => ['home', 'errors'].includes(id))) {
  const originalReady = screen.ready;
  screen.ready = async (page) => {
    await originalReady(page);
    const record = await reportError(page);
    records.set(page, record);
    if (screen.id === 'errors') await page.goto(new URL(`/team/errors?errorId=${record.errorId}`, page.url()).href);
    else await page.reload();
    await page.getByRole('button', { name: '标记已处理', exact: true }).waitFor();
  };
  screen.actions = [async (page) => {
    const { errorId } = records.get(page);
    await page.getByRole('button', { name: '标记已处理', exact: true }).click();
    if (screen.id === 'home') await page.getByText('现在没有出错的任务。', { exact: false }).waitFor();
    else await page.getByText('已处理', { exact: true }).waitFor();
    await page.reload();
    if (screen.id === 'home') await page.getByText('现在没有出错的任务。', { exact: false }).waitFor();
    else await page.getByText('已处理', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '标记已处理', exact: true }).count(), 0);
    const history = await (await page.request.get(new URL(`/api/team/errors?errorId=${errorId}`, page.url()).href)).json();
    assert.equal(history.items.length, 1);
    assert.ok(history.items[0].resolvedAt);
    const diagnostic = await page.request.get(new URL(`/api/team/errors/${errorId}/diagnostics`, page.url()).href);
    assert.equal(diagnostic.status(), 200);
    assert.equal((await diagnostic.json()).code, 'resolution_browser_fixture');
    const dashboard = await (await page.request.get(new URL('/api/team/dashboard', page.url()).href)).json();
    assert.equal(dashboard.errors.some((item) => item.errorId === errorId), false);
  }];
}

await import('./ui-acceptance.playwright.test.mjs');
