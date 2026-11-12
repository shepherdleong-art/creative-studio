import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n){
  if(s==='next/server') return n('next/server.js',c);
  try { return await n(s,c); } catch(e) {
    if(e.code!=='ERR_UNSUPPORTED_DIR_IMPORT') throw e;
    return n(s+'/index.ts',c);
  }
}`)}`, import.meta.url);

// 真实路由 + 隔离数据库；不启动队列，全部网络请求直接拒绝。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-image-whitelist-'));
const previousEnv = { ...process.env };
const previousFetch = globalThis.fetch;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
process.env.CREATIVE_STUDIO_CANVAS_ENABLE = '0';
globalThis.fetch = async () => { throw new Error('白名单回归不得调用外部服务'); };

const { getDb, closeDb } = await import('../lib/db.ts');
const { seedProviders } = await import('../lib/seed.ts');
const { resolveGptImage2Size } = await import('../lib/gpt-image-2-size-presets.ts');
const projects = await import('../app/api/projects/route.ts');
const sceneJobs = await import('../app/api/projects/[id]/scene-jobs/route.ts');
const applyScene = await import('../app/api/shot-sets/[id]/apply-scene/route.ts');
const regenerate = await import('../app/api/jobs/[id]/regenerate/route.ts');

function request(body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
async function expectResponse(response: Response, status = 200): Promise<Record<string, unknown>> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as Record<string, unknown>;
}
const identity = { storeCode: 'B店', productCode: '白名单回归', productionType: 'AI种草', editorName: '测试' };
const tencentId = 'company-gateway-image2-medium';
const qiniuId = 'company-gateway-qiniuyun-gpt-image-2-medium';
const cases = [
  ['9:16', ['1k', '2k', '4k']],
  ['5:4', ['1k', '2k', '4k']],
  ['4:5', ['1k', '2k', '4k']],
  ['2:1', ['1k', '2k']],
  ['1:2', ['1k', '2k']],
  ['9:21', ['1k', '2k']],
] as const;

try {
  const db = getDb();
  seedProviders();
  db.prepare("UPDATE providers SET apiKey = 'fixture-key', enabled = 1 WHERE id IN (?, ?)").run(tencentId, qiniuId);
  const jobIds = (projectId: string) => db.prepare('SELECT id FROM jobs WHERE projectId = ?').pluck().all(projectId) as string[];
  let serial = 0;
  function image(projectId: string | null, role: string): string {
    const id = 'whitelist-image-' + ++serial;
    db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
      VALUES (?, ?, ?, ?, ?, 'image/png')`).run(id, projectId, role, id + '.png', path.join(root, id + '.png'));
    return id;
  }
  function assertSize(ids: string[], size: string, model: string) {
    assert.ok(ids.length > 0);
    for (const id of ids) {
      const row = db.prepare('SELECT size, model FROM jobs WHERE id = ?').get(id) as { size: string; model: string };
      assert.equal(row.size, size);
      assert.equal(row.model, model);
    }
  }

  for (const [ratio, resolutions] of cases) for (const resolution of resolutions) {
    const size = resolveGptImage2Size(ratio, resolution);
    const seedId = image(null, 'input');
    const shotId = image(null, 'input');
    const created = await expectResponse(await projects.POST(request({
      ...identity, providerId: tencentId, model: 'image2-medium', aspectRatio: ratio, resolution,
      sceneSeedImageId: seedId, scenePrompt: '保持主体，更换场景', shotImageIds: [shotId], generationCount: 1,
    }) as never));
    const projectId = String(created.id);
    const setId = db.prepare('SELECT id FROM shot_sets WHERE projectId = ?').pluck().get(projectId) as string;
    assert.ok(setId);
    assertSize(jobIds(projectId), size, 'image2-medium');

    const scene = await expectResponse(await sceneJobs.POST(request({
      sceneSeedImageId: seedId, scenePrompt: '生成新场景', generationCount: 2,
    }) as never, { params: Promise.resolve({ id: projectId }) }));
    assertSize(scene.jobIds as string[], size, 'image2-medium');
    const refImage = image(projectId, 'reference');
    const refId = 'whitelist-ref-' + ++serial;
    db.prepare('INSERT INTO scene_references (id, projectId, imageAssetId, name) VALUES (?, ?, ?, ?)')
      .run(refId, projectId, refImage, '测试场景');
    const applied = await expectResponse(await applyScene.POST(request({
      sceneReferenceId: refId, prompt: '保持图1产品，参考图2场景',
    }) as never, { params: Promise.resolve({ id: setId }) }));
    assertSize(applied.jobIds as string[], size, 'image2-medium');
    const sourceJobId = (applied.jobIds as string[])[0];
    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(sourceJobId);
    const redone = await expectResponse(await regenerate.POST(request({
      prompt: '保持产品主体重新生成',
    }) as never, { params: Promise.resolve({ id: sourceJobId }) }));
    assertSize([String(redone.newJobId)], size, 'image2-medium');

    // 七牛不支持这些新增画幅，切换时应在创建任务前说明原因，保留原有任务与分镜状态。
    if (ratio !== '9:16') {
      const before = jobIds(projectId);
      await expectResponse(await sceneJobs.POST(request({
        providerId: qiniuId, sceneSeedImageId: seedId, scenePrompt: '不能改画幅', generationCount: 1,
      }) as never, { params: Promise.resolve({ id: projectId }) }), 400);
      await expectResponse(await applyScene.POST(request({
        providerId: qiniuId, sceneReferenceId: refId, prompt: '不能改画幅',
      }) as never, { params: Promise.resolve({ id: setId }) }), 400);
      await expectResponse(await regenerate.POST(request({
        providerId: qiniuId, prompt: '不能改画幅',
      }) as never, { params: Promise.resolve({ id: sourceJobId }) }), 400);
      assert.deepEqual(jobIds(projectId), before, '被拒的供应商切换不能创建任务');
    }
  }

  // size-only 调用与前端比例/档位调用一致，不能借旧 API 绕过完整组合校验。
  for (const ratio of ['2:1', '1:2', '9:21']) {
    const before = db.prepare('SELECT COUNT(*) FROM projects').pluck().get();
    for (const output of [{ aspectRatio: ratio, resolution: '4k' }, { size: resolveGptImage2Size(ratio, '4k') }]) {
      await expectResponse(await projects.POST(request({
        ...identity, providerId: tencentId, model: 'image2-medium', ...output,
      }) as never), 400);
    }
    assert.equal(db.prepare('SELECT COUNT(*) FROM projects').pluck().get(), before);
  }
  for (const providerId of [tencentId, qiniuId]) {
    await expectResponse(await projects.POST(request({
      ...identity, providerId, model: providerId === tencentId ? 'image2-medium' : 'qiniuyun/gpt-image-2-medium',
      size: resolveGptImage2Size('3:4', '4k'),
    }) as never));
  }
  console.log('ordinary project image whitelist tests passed (paid calls: 0)');
} finally {
  closeDb();
  globalThis.fetch = previousFetch;
  process.env = previousEnv;
  assert.ok(path.basename(root).startsWith('project-image-whitelist-'));
  fs.rmSync(root, { recursive: true, force: true });
}
