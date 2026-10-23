import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real browser + HTTP seam; called by the isolated BGM fixture with M7_REVIEW_ONLY=1. */
export async function runReviewVersionBrowserCases({ page, baseUrl, projectId, batchId, planIds }) {
  const api = `${baseUrl}/api/batch-production/batches/${batchId}`;
  const reviewUrl = `${api}/outputs/review?projectId=${projectId}`;
  const json = async (url, body) => {
    const response = await fetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const artifactDir = fileURLToPath(new URL('../outputs/batch-review-version-browser/', import.meta.url));
  fs.mkdirSync(artifactDir, { recursive: true });
  const displayedIssues = page.getByTestId('batch-review-issues');
  await displayedIssues.getByText(/本次确认包含的提醒/).click();
  await displayedIssues.getByText('检查产品颜色', { exact: true }).waitFor();
  const otherEditor = await page.context().newPage();
  otherEditor.setDefaultTimeout(10_000);
  await otherEditor.goto(page.url(), { waitUntil: 'domcontentloaded' });
  await otherEditor.getByRole('button', { name: /检查成片/ }).click();
  await otherEditor.getByRole('button', { name: '配音BGM', exact: true }).click();
  let editInOtherPage = true;
  await page.route('**/outputs/review?*', async route => {
    if (editInOtherPage) {
      const editedPromise = otherEditor.waitForResponse(response => response.url().includes(`/outputs/${planIds[0]}/clips?`) && response.request().method() === 'POST');
      const volume = otherEditor.getByRole('complementary', { name: '成片属性' }).locator('input[type="range"]').first();
      await volume.focus();
      await volume.press('ArrowLeft');
      await otherEditor.getByRole('button', { name: '应用音量', exact: true }).click();
      assert.equal((await editedPromise).status(), 200);
      editInOtherPage = false;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '全选 (2)', exact: true }).click();
  const requestPromise = page.waitForRequest(request => request.url().includes('/outputs/review?') && request.method() === 'POST');
  const partialPromise = page.waitForResponse(response => response.url() === reviewUrl && response.request().method() === 'POST');
  await page.getByRole('button', { name: '通过已选 (2)', exact: true }).click();
  const body = (await requestPromise).postDataJSON();
  assert(Array.isArray(body.items), '批量确认必须提交页面所见版本，不能只提交成片编号');
  assert.deepEqual(body.items.map(item => item.planId).sort(), [...planIds].sort());
  for (const item of body.items) {
    assert.equal(typeof item.outputVersionId, 'string');
    assert.equal(item.editRevision, 0);
    assert.match(item.issueSetHash, /^sha256:[a-f0-9]{64}$/);
  }
  const partial = await (await partialPromise).json();
  assert.deepEqual(partial.results.map(item => item.status), ['conflict', 'saved']);
  await page.getByText(/已确认 1 条成片。 1 条未保存/).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '选择成片 1', exact: true }).isChecked(), true, '冲突项保留选择');
  let workspace = (await json(`${api}/workspace?projectId=${projectId}`)).body;
  assert.deepEqual(workspace.cards.map(card => card.approved), [false, true]);
  await page.screenshot({ path: path.join(artifactDir, 'partial-review.png'), fullPage: true });

  // Another save races a single confirmation. Failure must not hide the film or advance the preview.
  editInOtherPage = true;
  const singlePromise = page.waitForResponse(response => response.url() === reviewUrl && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认这条', exact: true }).click();
  assert.equal((await (await singlePromise).json()).results[0].status, 'conflict');
  await page.getByText('审核未保存，请查看页面上方提示后重试。', { exact: true }).waitFor();
  await page.getByText('视频预览 · 01 换源脚本', { exact: true }).waitFor();
  // Explicitly reopening the page lets the user inspect the new saved arrangement.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /检查成片/ }).click();
  await page.getByTestId('batch-review-issues').waitFor();
  const freshPromise = page.waitForResponse(response => response.url() === reviewUrl && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认这条', exact: true }).click();
  assert.equal((await (await freshPromise).json()).results[0].status, 'saved');
  await page.getByText('视频预览 · 02 换源脚本', { exact: true }).waitFor();
  workspace = (await json(`${api}/workspace?projectId=${projectId}`)).body;
  assert(workspace.cards.every(card => card.approved));

  // Old browser payloads and malformed identities fail at the HTTP boundary, without changing the approved state.
  assert.equal((await json(reviewUrl, { planIds, decision: 'cancelled' })).status, 400);
  assert.equal((await json(reviewUrl, { items: [{ planId: planIds[0] }], decision: 'approved' })).status, 400);
  assert((await json(`${api}/workspace?projectId=${projectId}`)).body.cards.every(card => card.approved));
  await page.screenshot({ path: path.join(artifactDir, 'confirmed.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.getByTestId('batch-review-issues').getByText(/本次确认包含的提醒/).click();
  await page.getByTestId('batch-review-issues').getByText('检查产品颜色', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, 'confirmed-dark.png'), fullPage: true });
  await otherEditor.close();
  console.log('review browser: two editors, displayed issues/identity, partial conflict, no automatic advance, refresh, themes and HTTP validation passed');
}
