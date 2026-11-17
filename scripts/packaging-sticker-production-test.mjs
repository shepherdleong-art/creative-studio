import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyStickerProductionMedia } from './packaging-sticker-production-media.mjs';
import { createUiAcceptanceApi } from './team-server/ui-acceptance-fixtures.mjs';

export function stickerTestServerLaunch(testEnv, port) {
  const production = process.env.STICKER_TEST_STANDALONE;
  if (!production) return {
    args: [path.resolve('node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    options: { cwd: process.cwd(), env: testEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  };
  const standalone = fs.realpathSync(production);
  assert.ok(process.env.STICKER_TEST_EVIDENCE_DIR, 'STICKER_TEST_EVIDENCE_DIR is required for production evidence');
  let adminCredential;
  if (process.env.STICKER_TEST_TEAM === '1') {
    Object.assign(testEnv, {
      CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server', CREATIVE_STUDIO_PORT: String(port),
      CREATIVE_STUDIO_DEPLOYMENT_ID: 'sticker-production-acceptance', CREATIVE_STUDIO_TRUSTED_ORIGIN: `http://127.0.0.1:${port}`,
      CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1', STICKER_FIXTURE_TEAM_EMPLOYEE: 'sticker-employee',
    });
    const initialized = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', 'sticker-admin', '--name', '贴纸验收管理员'],
      { cwd: process.cwd(), env: testEnv, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    assert.equal(initialized.status, 0, 'isolated team administrator initialization failed');
    adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout)?.[1];
    assert.ok(adminCredential);
  }
  assert.ok(fs.existsSync(path.join(standalone, 'server.js')));
  for (const forbidden of ['data', 'storage', 'outputs', 'scripts', '.git', '.env.local']) {
    assert.equal(fs.existsSync(path.join(standalone, forbidden)), false, `production includes ${forbidden}`);
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(standalone, 'packaging/stickers/catalog.json'), 'utf8'));
  assert.equal(catalog.assets.length, 115);
  const scratch = path.join(testEnv.CREATIVE_STUDIO_DATA_ROOT, 'temp');
  fs.mkdirSync(scratch, { recursive: true });
  return {
    adminCredential,
    args: [path.join(standalone, 'server.js')],
    options: {
      cwd: standalone, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...testEnv, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', NODE_PATH: '',
        TEMP: scratch, TMP: scratch,
        STICKER_TEST_STANDALONE: standalone, STICKER_TEST_SOURCE_ROOT: process.cwd(),
        CREATIVE_STUDIO_PACKAGING_DIR: path.join(standalone, 'packaging'),
        NODE_OPTIONS: [
          `--require=${JSON.stringify(path.resolve('scripts/team-server/no-external-network.cjs'))}`,
          `--require=${JSON.stringify(path.resolve('scripts/team-server/sticker-production-guard.cjs'))}`,
        ].join(' '),
      },
    },
  };
}

export async function setupStickerTeamBrowser(baseUrl, launch) {
  if (!launch.adminCredential) return {};
  const api = createUiAcceptanceApi(baseUrl);
  const admin = await api.activate('sticker-admin', launch.adminCredential, 'sticker-admin-test-password');
  const employee = await api.createEmployee(admin, { employeeId: 'sticker-employee', displayName: '贴纸验收员工' });
  const session = await api.activate('sticker-employee', employee.credential, 'sticker-employee-test-password');
  return {
    storageState: { origins: [], cookies: session.cookies.map(pair => {
      const equal = pair.indexOf('=');
      return { name: pair.slice(0, equal), value: pair.slice(equal + 1), domain: '127.0.0.1', path: '/',
        expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' };
    }) },
    extraHTTPHeaders: { Origin: baseUrl, 'x-csrf-token': session.csrf,
      'x-creative-studio-client-version': '0.7.1', 'x-creative-studio-client-api': '1' },
  };
}

async function json(page, route, body) {
  const url = new URL(route, page.url()).href;
  const response = body === undefined ? await page.request.get(url) : await page.request.post(url, { data: body });
  const value = await response.json();
  assert.ok(response.ok(), `${route}: ${response.status()} ${JSON.stringify(value)}`);
  return value;
}

async function poll(read, finished, label) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (finished(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(label + ' timed out');
}

async function download(page, url, filename) {
  const response = await page.request.get(new URL(url, page.url()).href);
  assert.equal(response.status(), 200, url);
  const bytes = await response.body();
  assert.ok(bytes.length > 1000, 'export must contain real media');
  const directory = path.resolve(process.env.STICKER_TEST_EVIDENCE_DIR);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), bytes);
  return { filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function verifyProductionResources(page, prefix) {
  const catalog = await json(page, '/api/packaging/stickers/catalog.json');
  assert.equal(catalog.assets.length, 115);
  let bytes = 0;
  for (const asset of catalog.assets) for (const relative of [asset.file, asset.thumbnail]) {
    const response = await page.request.get(new URL(`/api/packaging/stickers/${relative}`, page.url()).href);
    assert.equal(response.status(), 200, relative);
    const buffer = await response.body();
    const expected = fs.readFileSync(path.join(process.env.STICKER_TEST_STANDALONE, 'packaging/stickers', relative));
    assert.ok(buffer.equals(expected), relative);
    if (relative === asset.file) assert.equal(createHash('sha256').update(buffer).digest('hex'), asset.sha256);
    bytes += buffer.length;
  }
  const runtime = await page.request.get(new URL('/api/packaging/templates/overlay-poster/stickers/runtime.js', page.url()).href);
  assert.equal(runtime.status(), 200);
  assert.ok((await runtime.body()).equals(fs.readFileSync(path.join(process.env.STICKER_TEST_STANDALONE, 'packaging/stickers/runtime.js'))));
  fs.writeFileSync(path.join(process.env.STICKER_TEST_EVIDENCE_DIR, `${prefix}-resources.json`), JSON.stringify({ originals: 115, thumbnails: 115, bytes, runtimeSha256: createHash('sha256').update(await runtime.body()).digest('hex') }, null, 2));
}

export async function verifySingleStickerProductionExport(page, groupId) {
  if (!process.env.STICKER_TEST_STANDALONE) return;
  fs.mkdirSync(process.env.STICKER_TEST_EVIDENCE_DIR, { recursive: true });
  await verifyProductionResources(page, 'single');
  const group = await json(page, `/api/final-edit-groups/${groupId}`);
  assert.ok(group.packaging.stickers.length > 0);
  await page.getByRole('button', { name: '下一步：导出', exact: true }).click();
  await page.getByRole('heading', { name: '导出并写回项目' }).waitFor();
  let response;
  try {
    [response] = await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/final-edit-variants/')
        && response.url().endsWith('/render') && response.request().method() === 'POST', { timeout: 60_000 }),
      page.getByRole('button', { name: '开始导出（含自动包装）', exact: true }).click(),
    ]);
  } catch (error) {
    throw new Error(`正式导出入口未受理：${error.message}\n${await page.locator('body').innerText()}`);
  }
  const queued = await response.json();
  assert.ok(response.ok(), JSON.stringify(queued));
  console.log('Production single render queued: ' + queued.id);
  const readJob = id => json(page, `/api/final-edit-jobs/${id}`);
  const finished = value => {
    assert.ok(!['failed', 'cancelled'].includes(value.status), JSON.stringify(value));
    return value.status === 'succeeded';
  };
  const rendered = await poll(() => readJob(queued.id), finished, 'single render');
  const packagingId = rendered.output?.packagingJobId;
  assert.ok(packagingId, 'sticker export must enqueue automatic packaging');
  const packaged = await poll(() => readJob(packagingId), finished, 'single packaging');
  const artifact = await download(page, packaged.output.videoDownloadUrl, 'single-stickers.mp4');
  const cover = await download(page, rendered.output.coverDownloadUrl, 'single-stickers.jpg');
  const media = await verifyStickerProductionMedia(artifact.filename, group.packaging, group.variants[0].timeline.bodyFrames + 20);
  fs.writeFileSync(path.join(process.env.STICKER_TEST_EVIDENCE_DIR, 'single-export.json'), JSON.stringify({ groupId, renderId: queued.id, packagingId, stickerCount: group.packaging.stickers.length, artifact, cover, media }, null, 2));
}

export async function verifyBatchStickerProductionExport(page, fixture, spec) {
  if (!process.env.STICKER_TEST_STANDALONE) return;
  fs.mkdirSync(process.env.STICKER_TEST_EVIDENCE_DIR, { recursive: true });
  const prefix = spec.key === 'source' ? 'batch' : `batch-${spec.key}`;
  if (spec.key === 'source') await verifyProductionResources(page, 'batch');
  const arrangement = await json(page, `/api/batch-production/batches/${fixture.batchId}/outputs/${spec.planId}/arrangement?projectId=${fixture.projectId}`);
  await json(page, `/api/batch-production/batches/${fixture.batchId}/outputs/review?projectId=${fixture.projectId}`, {
    planIds: [spec.planId], decision: 'approved',
  });
  const route = `/api/batch-production/batches/${fixture.batchId}/exports?projectId=${fixture.projectId}`;
  const exported = await poll(() => json(page, route, { planIds: [spec.planId] }), value => {
    assert.equal(value.failed, 0, JSON.stringify(value));
    assert.equal(value.skipped, 0, JSON.stringify(value));
    return value.published + value.alreadyPublished === 1;
  }, 'batch export');
  const manifest = await json(page, `/api/batch-production/batches/${fixture.batchId}/downloads?projectId=${fixture.projectId}&scope=both`);
  assert.equal(manifest.items.filter(item => item.planId === spec.planId).length, 2);
  const archive = await download(page, `/api/batch-production/batches/${fixture.batchId}/downloads/zip?projectId=${fixture.projectId}&scope=both`, `${prefix}-stickers.zip`);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(process.env.STICKER_TEST_EVIDENCE_DIR, archive.filename)));
  for (const item of manifest.items) {
    const entry = zip.file(item.relativeName);
    assert.ok(entry, item.relativeName);
    const bytes = await entry.async('nodebuffer');
    assert.equal(bytes.length, item.byteSize);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    if (item.planId === spec.planId) fs.writeFileSync(path.join(process.env.STICKER_TEST_EVIDENCE_DIR, `${prefix}-stickers.${item.kind === 'video' ? 'mp4' : 'jpg'}`), bytes);
  }
  const media = await verifyStickerProductionMedia(`${prefix}-stickers.mp4`, arrangement.packaging, spec.bodySec * 24 + 20);
  fs.writeFileSync(path.join(process.env.STICKER_TEST_EVIDENCE_DIR, `${prefix}-export.json`), JSON.stringify({ exported, manifest, archive, media }, null, 2));
  console.log(`Production batch export verified: ${spec.key}, ${media.decodedFrames} frames`);
}
