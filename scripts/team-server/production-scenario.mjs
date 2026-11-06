// Same running server, one data root, real HTTP configuration and workers.
// Only the external AI responses are simulated; SQLite is opened read-only for
// observing recovery without waking any business API.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';

export async function runProductionScenario({ root, admin, sessions, projects, jsonRequest, request, stopServer, startServer, waitReady, enableSchedulers, makeMedia, taskHistoryOnly = false }) {
  const output = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#547799' } }).png().toBuffer();
  const calls = { images: 0, llm: 0 };
  const fake = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; /* drain without retaining credentials */ }
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('/images/')) {
      calls.images++;
      res.end(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }));
    } else if (req.url?.endsWith('/chat/completions')) {
      calls.llm++;
      const extraction = {
        productName: '蓝色沙发', category: '家具', brand: '',
        pageIdentities: [{ pageIndex: 0, productName: '蓝色沙发', category: '家具', brand: '' }],
        sellingPoints: [{ title: '蓝色外观', detail: '沙发表面呈蓝色，可以从图片直接观察。',
          factText: '沙发表面呈蓝色', evidenceQuote: '蓝色外观', imageRefs: [1], pointType: 'appearance', importance: 90 }],
      };
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(extraction) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
    } else { res.statusCode = 404; res.end('{"error":"unexpected_fake_request"}'); }
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${fake.address().port}`;
  let db;
  async function call(url, method = 'GET', json, expected = 200) {
    return (await jsonRequest(admin, url, { method, ...(json === undefined ? {} : { json }) }, expected)).body;
  }
  async function upload(projectId, targetKind, usage, bytes, name, mime) {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const created = await call('/api/team/uploads', 'POST', {
      targetKind, targetScope: { resourceType: 'project', resourceId: projectId }, usage, relativeName: name,
      mimeType: mime, expectedSize: bytes.length, expectedSha256: sha, sourceFingerprint: sha,
      idempotencyKey: `production-${name}`, partSize: 1024 * 1024,
    });
    for (const part of created.missingParts) {
      const response = await request(admin, `/api/team/uploads/${created.uploadId}/parts/${part}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes.subarray((part - 1) * 1024 * 1024, part * 1024 * 1024),
      });
      assert.equal(response.status, 200);
    }
    return call(`/api/team/uploads/${created.uploadId}/complete`, 'POST', { expectedSha256: sha });
  }
  const evidence = { sameDataRoot: true, businessSetup: 'HTTP APIs only', realPaidCalls: 0, calls,
    chains: [], recovery: {}, limitations: ['批量本轮执行真实代理转码，详情页执行真实卖点提取；完整口播成片另由主流程/模块验收覆盖。'] };
  try {
    const session = await call('/api/team/auth/session');
    const userId = session.principal?.userId ?? session.user?.userId ?? session.user?.id;
    assert.ok(userId, 'session must identify the administrator');
    const policy = await call(`/api/team/members/${userId}/policy`);
    await call(`/api/team/members/${userId}/policy`, 'PATCH',
      { monthlyLimitMinor: null, personalConcurrency: 4, paused: false, expectedVersion: policy.version ?? 0 });
    const imageProvider = await call('/api/providers', 'POST', {
      name: '同根生产图片', type: 'openai-compatible', baseUrl: upstream, apiKey: 'isolated-production-fixture',
      model: 'gpt-image-2',
    });
    const llmProvider = await call('/api/providers/script', 'POST', {
      name: '同根生产识图', type: 'openai-compatible', apiStyle: 'openai-compatible', baseUrl: upstream,
      apiKey: 'isolated-production-fixture', model: 'gpt-4o', supportsVision: true, enabled: true,
    });
    const project = await call('/api/projects', 'POST', {
      storeCode: 'B店', productCode: 'DELIVERY-ONE-ROOT', productionType: 'AI种草', editorName: '同根验收',
      providerId: imageProvider.id, model: 'gpt-image-2', size: '1024x1024', workflowType: 'complex_product', maxAttempts: 1,
    });
    const state = await call('/api/team/pools');
    const changes = [
      { action: 'bind-media-upstream', entityType: 'image', entityId: imageProvider.id,
        poolKey: 'media:production-test', capacity: 0, expectedVersion: 0 },
      ...['llm:remote'].map((key) => {
        const item = state.requirements.find((entry) => entry.poolKey === key);
        assert.ok(item, `pool must be configurable before submitting any tasks: ${key}`);
        return { action: 'upsert', poolKey: key, kind: 'remote', capacity: 0, enabled: true,
          mappingSnapshot: item.mappingSnapshot, expectedVersion: item.poolVersion ?? 0 };
      }),
    ];
    await call('/api/team/pools', 'POST', { changes });
    const scene = taskHistoryOnly ? { jobIds: [] } : await (async () => {
      const imageUpload = await upload(project.id, 'project_image', 'image', output, 'scene.png', 'image/png');
      return call(`/api/projects/${project.id}/scene-jobs`, 'POST', {
        sceneSeedImageId: imageUpload.resultResourceId, scenePrompt: '保持产品并生成客厅场景', generationCount: 1, maxAttempts: 1,
      });
    })();
    const detailUpload = await upload(project.id, 'detail_page_source', 'detail_page', output, 'detail.png', 'image/png');
    const source = detailUpload.resultResourceId;
    const script = await call(`/api/projects/${project.id}/script-studio/tasks`, 'POST', {
      sourceSetId: source, providerId: llmProvider.id, targetDurationSec: 15, requestedCount: 1,
      extractOnly: true, requestKey: 'production-extract-once',
    }, 202);
    let canvasRun = { tasks: [] };
    let batchUpload = null;
    if (!taskHistoryOnly) {
      const canvas = (await call('/api/canvas', 'POST', { name: '同根生产画布' }, 201)).canvas;
      const models = (await call('/api/canvas/models')).models;
      const model = models.find((item) => item.displayName.includes('同根生产图片'));
      assert.ok(model, 'configured provider must be available on canvas');
      const graph = { schemaVersion: 1, nodes: [{ id: 'image', kind: 'image-generation', position: { x: 0, y: 0 },
        data: { title: '同根图片', modelKey: model.key, generationMode: 'text-to-image', prompt: '蓝色沙发',
          parameters: {}, references: [], referenceLabelCounter: 0 } }], edges: [] };
      const saved = await call(`/api/canvas/${canvas.id}`, 'PATCH', { graph, expectedGraphRevision: 0 });
      const planBody = { mode: 'single', targetNodeId: 'image', requestKey: 'production-canvas-once',
        expectedGraphRevision: saved.canvas.graphRevision };
      const plan = await call(`/api/canvas/${canvas.id}/plan`, 'POST', planBody);
      canvasRun = await call(`/api/canvas/${canvas.id}/runs`, 'POST', { ...planBody, planFingerprint: plan.plan.fingerprint });
      const video = fs.readFileSync(await makeMedia());
      batchUpload = await upload(project.id, 'batch_asset', 'batch_asset', video, 'batch.mp4', 'video/mp4');
    }

    // Pools stay closed until all work is persisted. No manual database writes.
    const configured = await call('/api/team/pools');
    await call('/api/team/pools', 'POST', { changes: changes.map((change) => ({
      ...change, capacity: 2, expectedVersion: configured.pools.find((pool) => pool.poolKey === change.poolKey).version,
    })) });
    const proxy = taskHistoryOnly ? { requested: [] } : await call(`/api/batch-production/assets/${batchUpload.resultResourceId}/proxies?projectId=${project.id}`, 'POST', {});
    await stopServer();
    db = new Database(path.join(root, 'data', 'workbench.db'), { readonly: true, fileMustExist: true });
    const scriptBefore = db.prepare('SELECT status FROM script_studio_tasks WHERE id = ?').get(script.task.id);
    assert.equal(scriptBefore.status, 'queued', 'script scheduler remains off before restart');
    enableSchedulers();
    startServer();
    await waitReady();
    // Read-only DB polling is intentional: no business endpoint can lazily start a worker.
    const until = async (read, predicate, label) => {
      const deadline = Date.now() + 120_000;
      let current;
      while (Date.now() < deadline) {
        current = read();
        if (predicate(current)) return current;
        if (['failed', 'cancelled'].includes(current?.status ?? current?.phase)) {
          throw new Error(`${label} failed: ${JSON.stringify(current)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`${label} timeout: ${JSON.stringify(current)}`);
    };
    const image = taskHistoryOnly ? {} : await until(() => db.prepare('SELECT status, errorMessage, outputImageId FROM jobs WHERE id = ?').get(scene.jobIds[0]),
      (row) => row.status === 'succeeded', 'legacy image');
    const detail = await until(() => db.prepare('SELECT status, errorMessage FROM script_studio_tasks WHERE id = ?').get(script.task.id),
      (row) => row.status === 'succeeded', 'script studio');
    const canvasTask = taskHistoryOnly ? {} : await until(() => db.prepare('SELECT phase, errorMessage, outputAssetId FROM creative_canvas_tasks WHERE id = ?').get(canvasRun.tasks[0].id),
      (row) => row.phase === 'succeeded', 'canvas');
    const batchTask = taskHistoryOnly ? {} : await until(() => db.prepare('SELECT status FROM batch_tasks WHERE id = ?').get(proxy.requested[0].taskId),
      (row) => row.status === 'succeeded', 'batch proxy');
    evidence.chains = taskHistoryOnly ? [{ module: 'script-studio', taskId: script.task.id, ...detail }] : [
      { module: 'regular', taskId: scene.jobIds[0], ...image },
      { module: 'script-studio', taskId: script.task.id, ...detail },
      { module: 'canvas', taskId: canvasRun.tasks[0].id, ...canvasTask },
      { module: 'batch', taskId: proxy.requested[0].taskId, ...batchTask },
    ];
    if (!taskHistoryOnly) {
      const mediaPools = db.prepare("SELECT requiredPoolsJson FROM execution_operations WHERE module IN ('image', 'canvas')").all();
      assert.equal(mediaPools.length, 2);
      for (const operation of mediaPools) assert.deepEqual(JSON.parse(operation.requiredPoolsJson), ['media:production-test']);
      evidence.sharedMediaPool = 'media:production-test';
    }
    const counts = { ...calls };
    await stopServer();
    startServer();
    await waitReady();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    assert.deepEqual(calls, counts, 'completed tasks must never repeat provider POST after restart');
    assert.equal(calls.images, taskHistoryOnly ? 0 : 2, taskHistoryOnly ? 'script-only history must not submit image work' : 'one legacy image and one canvas image');
    assert.equal(calls.llm, 1, 'one persisted direct-vision extraction');
    const employee = sessions[1] ?? sessions[0];
    if (taskHistoryOnly) {
      const historyBefore = await until(() => db.prepare('SELECT status FROM script_studio_tasks WHERE id = ?').get(script.task.id),
        (row) => row.status === 'succeeded', 'script-only task display history');
      assert.equal(historyBefore.status, 'succeeded');
      db.close();
      db = null;
    }
    const scriptProvider = (await call(`/api/providers/script/${llmProvider.id}`, 'PUT', {
      name: '修改后的当前供应商', model: 'changed-current-default-model',
    }));
    assert.equal(scriptProvider.model, 'changed-current-default-model');
    const history = (await jsonRequest(employee, '/api/team/tasks', {}, 200)).body.items.filter((item) => item.taskId === script.task.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].model, 'gpt-4o', '历史任务必须使用冻结请求模型，不读修改后的默认模型');
    assert.equal(history[0].providerName, '同根生产识图');
    assert.equal(history[0].scopeName, projects[1]?.name ?? project.name);
    assert.equal(history[0].stepName, '详情页素材分析');
    assert.equal(history[0].stepName.includes('plan'), false);
    assert.equal(history[0].stepName.includes('batch'), false);
    assert.equal(JSON.stringify(history[0]).includes('isolated-production-fixture'), false);
    assert.equal(JSON.stringify(history[0]).includes('providerSnapshot'), false);
    assert.equal(JSON.stringify(history[0]).includes('inputSnapshot'), false);
    evidence.taskDisplay = { taskId: script.task.id, model: history[0].model, providerName: history[0].providerName,
      currentProviderModel: scriptProvider.model, stepName: history[0].stepName };
    evidence.recovery = { scriptQueuedBeforeRestart: true, businessRequestsDuringRecovery: 0, repeatedPosts: 0 };
    return evidence;
  } finally {
    db?.close();
    fake.closeAllConnections();
    await new Promise((resolve) => fake.close(resolve));
  }
}
