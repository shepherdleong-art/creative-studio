import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 11 号票 · 路由级验收：
 *   1. `GET /api/batch-production/batches/[id]/downloads` 只列当前正式产物并带大小；
 *   2. `scope` 三种选项各取正确的文件；
 *   3. 请求别人的批次被拒（403 / 404），拿不到任何文件名；
 *   4. `GET …/downloads/zip` 的 ZIP 内容与清单逐项一致（解压比对文件名与字节数）；
 *   5. 没有可下载成片时两边都给「还没有导出过的成片」。
 *
 * 走真实 `withTeamRoute`（真实会话 Cookie、CSRF、batch scope 归属检查），
 * 不 mock 授权层 —— 越权断言才有意义。
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensions = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
interface ResolvedModule { url: string; format?: string | null; shortCircuit?: boolean }
interface ResolveContext { parentURL?: string; conditions?: unknown }
const { registerHooks } = module as unknown as {
  registerHooks: (hooks: {
    resolve: (specifier: string, context: ResolveContext, nextResolve: (specifier: string, context?: ResolveContext) => ResolvedModule) => ResolvedModule;
  }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const candidate = fs.existsSync(base) && fs.statSync(base).isFile()
        ? base : extensions.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
      if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
        if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
        if (!specifier.startsWith('/')) return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-downloads-route-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-batch-downloads-route',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');
const { registerRootScope, registerInheritedScope, createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { ensureBatchSchemaReady } = await import('../lib/batch-production/schema.ts');
const { resolveCoverContractHash, resolveFullRenderContractHash } = await import('../lib/batch-production/cover-contract.ts');
const { createBatchTask } = await import('../lib/batch-production/tasks.ts');
const JSZip = (await import('jszip')).default;

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-batch-downloads-route', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.notEqual(
  (await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'data', 'backups', 'batch') })).state,
  'compatibility_only',
);

const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-batch-downloads-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-batch-downloads-password' });
const admin = adminSession.principal;
async function account(employeeId: string) {
  const created = await service.createUser(admin, { employeeId, displayName: employeeId, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-batch-downloads-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-batch-downloads-password` });
  return { principal: authenticated.principal, cookie: sessionCookie(authenticated.token).split(';', 1)[0] };
}
const userA = await account('0001');
const userB = await account('0002');

function request(url: string, user: { cookie: string }, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cookie', `${user.cookie}; __Host-team_csrf=csrf-test`);
  headers.set('Origin', 'https://studio.example.test');
  headers.set('x-csrf-token', 'csrf-test');
  return new Request(url, { ...init, headers });
}

const storageRoot = path.join(root, 'storage');
const now = '2026-11-08T02:00:00.000Z';

function writeFile(relativePath: string, bytes: Buffer) {
  const absolute = path.join(storageRoot, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  return relativePath.split(path.sep).join('/');
}
const checksumOf = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** 造一个项目 + 批次，四张成片覆盖「已导出 / 修改未导出 / 从没导出 / 失败」。 */
function seedProject(projectId: string, ownerUserId: string, prefix: string) {
  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES (?, ?, '', 'fixture', 'gpt-image-2')`)
    .run(`provider-${prefix}`, `供应商 ${prefix}`);
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, productCode, createdAt, exportDirName)
    VALUES (?, ?, ?, 'gpt-image-2', '', ?, '2026-11-01T00:00:00.000Z', ?)`)
    .run(projectId, `项目 ${prefix}`, `provider-${prefix}`, `${prefix}-CODE`, `${prefix}-CODE-20261101`);
  registerRootScope(db, { resourceType: 'project', resourceId: projectId, ownerUserId });
  db.prepare(`INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, controlState, createdAt, updatedAt)
    VALUES (?, ?, ?, 'running', ?, '{}', 'running', ?, ?)`)
    .run(`batch-${prefix}`, projectId, `批次 ${prefix}`, `bv-${prefix}`, now, now);
  registerInheritedScope(db, { resourceType: 'batch', resourceId: `batch-${prefix}`, parent: { resourceType: 'project', resourceId: projectId } });
  db.prepare(`INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt)
    VALUES (?,?,1,4,'{}','frozen',?,?)`).run(`bv-${prefix}`, `batch-${prefix}`, now, now);
  registerInheritedScope(db, { resourceType: 'batch_version', resourceId: `bv-${prefix}`, parent: { resourceType: 'batch', resourceId: `batch-${prefix}` } });
  db.prepare(`INSERT INTO batch_scripts (id,projectId,sourceKind,sourceId,title,bodyText,sourceVersion,createdAt,updatedAt)
    VALUES (?,?,'script_draft','src','脚本','正文','v1',?,?)`).run(`script-${prefix}`, projectId, now, now);
  db.prepare(`INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt)
    VALUES (?,?,?,'脚本','正文','v1',4,?)`).run(`ss-${prefix}`, `bv-${prefix}`, `script-${prefix}`, now);
  db.prepare(`INSERT INTO batch_assets (id,projectId,sourceKind,locationJson,contentFingerprint,mediaKind,mediaJson,status,currentAnalysisId,createdAt,updatedAt)
    VALUES (?,?,'managed','{}',?,'video',?,'online',?,?,?)`)
    .run(`asset-${prefix}`, projectId, `sha256:asset-${prefix}`, JSON.stringify({ durationSec: 6 }), `analysis-${prefix}`, now, now);
  registerInheritedScope(db, { resourceType: 'batch_asset', resourceId: `asset-${prefix}`, parent: { resourceType: 'project', resourceId: projectId } });
  db.prepare(`INSERT INTO batch_asset_analysis (id,assetId,analyzerVersion,providerId,model,analysisJson,status,analyzedAt,createdAt)
    VALUES (?,?,'fixture','fixture','fixture',?,'ready',?,?)`)
    .run(`analysis-${prefix}`, `asset-${prefix}`, JSON.stringify({ durationUs: 6_000_000 }), now, now);
  db.prepare(`INSERT INTO batch_asset_pool_items (id,batchVersionId,assetId,analysisId,selectionState,createdAt)
    VALUES (?,?,?,?,'selected',?)`).run(`pool-${prefix}`, `bv-${prefix}`, `asset-${prefix}`, `analysis-${prefix}`, now);

  const arrangement = JSON.stringify({
    productionReady: true, preset: '3:4', editRevision: 0,
    clips: [{ clipId: 'clip-1', assetId: `asset-${prefix}`, sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000 }],
    cover: { assetId: `asset-${prefix}`, timeUs: 0 },
  });
  const plans: Array<[string, number, string, string | null, number]> = [
    ['exported', 1, 'ov-exported', 'video-exported', 1],
    ['reworked', 2, 'ov-reworked', 'video-reworked', 2],
    ['never', 3, 'ov-never', null, 1],
    ['failed', 4, 'ov-failed', null, 1],
  ];
  for (const [key, seq, versionId, artifactId, versionNumber] of plans) {
    db.prepare(`INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,currentArtifactId,createdAt)
      VALUES (?,?,?,?,'{}',?,?,?)`)
      .run(`plan-${prefix}-${key}`, `bv-${prefix}`, `ss-${prefix}`, seq, versionId, artifactId, now);
    registerInheritedScope(db, { resourceType: 'batch_plan', resourceId: `plan-${prefix}-${key}`, parent: { resourceType: 'batch_version', resourceId: `bv-${prefix}` } });
    db.prepare(`INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES (?,?,?,?,?)`)
      .run(versionId, `plan-${prefix}-${key}`, versionNumber, arrangement, now);
    registerInheritedScope(db, { resourceType: 'batch_output_version', resourceId: versionId, parent: { resourceType: 'batch_plan', resourceId: `plan-${prefix}-${key}` } });
  }
  // 「修改未导出」：旧版本的正式产物仍在，当前版本号是 2。
  db.prepare(`INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES (?,?,1,?,?)`)
    .run(`ov-reworked-old-${prefix}`, `plan-${prefix}-reworked`, arrangement, now);

  const exportedVideo = Buffer.alloc(4096, 11);
  const exportedCover = Buffer.alloc(1024, 12);
  const reworkedVideo = Buffer.alloc(2048, 13);
  const reworkedCover = Buffer.alloc(512, 14);
  const videoPath = writeFile(path.join(`projects/${prefix}-CODE-20261101/成片`, `${prefix}-CODE-01.mp4`), exportedVideo);
  const coverPath = writeFile(path.join(`projects/${prefix}-CODE-20261101/成片`, `${prefix}-CODE-01-封面.jpg`), exportedCover);
  const reworkedVideoPath = writeFile(path.join(`projects/${prefix}-CODE-20261101/成片`, `${prefix}-CODE-02.mp4`), reworkedVideo);
  const reworkedCoverPath = writeFile(path.join(`projects/${prefix}-CODE-20261101/成片`, `${prefix}-CODE-02-封面.jpg`), reworkedCover);
  const insertArtifact = db.prepare(`INSERT INTO batch_artifacts (id,projectId,batchId,batchVersionId,outputPlanId,outputVersionId,kind,relativePath,checksum,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const artifacts = [
    [`video-exported`, `plan-${prefix}-exported`, `ov-exported`, 'video', videoPath, checksumOf(exportedVideo)],
    [`cover-exported`, `plan-${prefix}-exported`, `ov-exported`, 'cover', coverPath, checksumOf(exportedCover)],
    [`video-reworked`, `plan-${prefix}-reworked`, `ov-reworked-old-${prefix}`, 'video', reworkedVideoPath, checksumOf(reworkedVideo)],
    [`cover-reworked`, `plan-${prefix}-reworked`, `ov-reworked-old-${prefix}`, 'cover', reworkedCoverPath, checksumOf(reworkedCover)],
  ];
  for (const [id, planId, versionId, kind, relativePath, checksum] of artifacts) {
    insertArtifact.run(id, projectId, `batch-${prefix}`, `bv-${prefix}`, planId, versionId, kind, relativePath, checksum, now);
    registerInheritedScope(db, { resourceType: 'batch_artifact', resourceId: id, parent: { resourceType: 'batch_plan', resourceId: planId } });
  }

  // 只有「已导出」是新鲜的：造一条成功的完整渲染 = 当前契约。
  // 官方领域入口要求已验证的访问上下文（server 模式不允许无主体写库）。
  const access = createTeamAccessContext({ db, principal: { userId: ownerUserId, role: 'employee' } });
  runWithAccessContext(access, () => {
    createBatchTask(db, projectId, {
      batchId: `batch-${prefix}`, workType: 'render', targetKind: 'output_version_cover', targetId: 'ov-exported',
      requestKey: `cover:ov-exported:${resolveCoverContractHash(db, 'ov-exported')}`,
    });
  });
  const fullTaskId = runWithAccessContext(access, () => createBatchTask(db, projectId, {
    batchId: `batch-${prefix}`, workType: 'render', targetKind: 'output_version', targetId: 'ov-exported',
    requestKey: `render:ov-exported:${resolveFullRenderContractHash(db, 'ov-exported')}`,
  }));
  db.prepare(`UPDATE batch_tasks SET status='succeeded', attemptCount=1 WHERE id=?`).run(fullTaskId);
  db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,resultJson,startedAt,finishedAt,createdAt)
    VALUES (?,?,1,'succeeded','{}',?,?,?,?)`).run(
    `attempt-${prefix}`, fullTaskId,
    JSON.stringify({
      projectId, batchId: `batch-${prefix}`, batchVersionId: `bv-${prefix}`,
      planId: `plan-${prefix}-exported`, outputVersionId: 'ov-exported', planSeq: 1, outputVersionNumber: 1,
      audioMode: 'narration', productionReady: true,
      videoChecksum: checksumOf(exportedVideo), coverChecksum: checksumOf(exportedCover),
      videoRelativePath: videoPath, coverRelativePath: coverPath,
    }),
    now, now, now,
  );
  // 「失败」：一条失败的整片渲染任务。
  const failedTaskId = runWithAccessContext(access, () => createBatchTask(db, projectId, {
    batchId: `batch-${prefix}`, workType: 'render', targetKind: 'output_version', targetId: 'ov-failed',
    requestKey: `render:ov-failed:${resolveFullRenderContractHash(db, 'ov-failed')}`,
  }));
  db.prepare(`UPDATE batch_tasks SET status='failed' WHERE id=?`).run(failedTaskId);

  return { batchId: `batch-${prefix}`, projectId, exportedVideo, exportedCover, reworkedVideo, reworkedCover };
}

const seeded = seedProject('project-a', userA.principal.userId, 'ACC');

const downloadsRoute = await import('../app/api/batch-production/batches/[id]/downloads/route.ts');
const zipRoute = await import('../app/api/batch-production/batches/[id]/downloads/zip/route.ts');

const downloadsUrl = (batchId: string, projectId: string, query = '') =>
  `https://studio.example.test/api/batch-production/batches/${batchId}/downloads?projectId=${projectId}${query}`;
const zipUrl = (batchId: string, projectId: string, query = '') =>
  `https://studio.example.test/api/batch-production/batches/${batchId}/downloads/zip?projectId=${projectId}${query}`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

interface ManifestItem {
  planId: string;
  seq: number;
  scriptTitle: string;
  kind: 'video' | 'cover';
  filename: string;
  relativeName: string;
  byteSize: number;
  sha256: string;
  checksum: string;
  outputVersionNumber: number;
  outdated: boolean;
}
interface ManifestBody {
  batchId: string;
  projectId: string;
  scope: string;
  exportDirName: string;
  outdated: boolean;
  items: ManifestItem[];
  totalBytes: number;
  emptyMessage?: string;
}
const readManifest = async (response: Response): Promise<ManifestBody> => (
  await response.json() as ManifestBody
);

try {
  // ---- 1. 自己是所有者：清单只含当前正式产物 ----
  const ownResponse = await downloadsRoute.GET(request(downloadsUrl(seeded.batchId, seeded.projectId), userA), params(seeded.batchId));
  assert.equal(ownResponse.status, 200, await ownResponse.clone().text());
  const manifest = await readManifest(ownResponse);
  assert.equal(manifest.scope, 'both');
  assert.equal(manifest.exportDirName, 'ACC-CODE-20261101');
  assert.deepEqual(
    manifest.items.map((item) => `${item.seq}:${item.kind}`).sort(),
    ['1:cover', '1:video', '2:cover', '2:video'],
    '从没导出与渲染失败的成片不得出现在清单里',
  );
  assert.equal(manifest.items.every((item) => Number.isSafeInteger(item.byteSize) && item.byteSize > 0), true);
  assert.equal(manifest.items.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)), true);
  const reworked = manifest.items.find((item) => item.seq === 2 && item.kind === 'video');
  assert.ok(reworked, '修改未导出必须有清单项');
  assert.equal(reworked.outdated, true, '修改未导出的清单项必须标 outdated');
  assert.equal(reworked.byteSize, 2048);
  assert.match(reworked.relativeName, /^ACC-CODE-20261101\/02-v1\//, '按项目与导出版本分目录');
  assert.equal(manifest.emptyMessage, undefined);

  // ---- 2. 三种 scope ----
  const videoOnly = await readManifest(await downloadsRoute.GET(request(downloadsUrl(seeded.batchId, seeded.projectId, '&scope=video'), userA), params(seeded.batchId)));
  assert.deepEqual(videoOnly.items.map((item) => item.kind), ['video', 'video']);
  const coverOnly = await readManifest(await downloadsRoute.GET(
    request(downloadsUrl(seeded.batchId, seeded.projectId, '&scope=cover'), userA), params(seeded.batchId),
  ));
  assert.deepEqual(coverOnly.items.map((item) => item.kind), ['cover', 'cover']);
  const invalidScope = await downloadsRoute.GET(
    request(downloadsUrl(seeded.batchId, seeded.projectId, '&scope=everything'), userA), params(seeded.batchId),
  );
  assert.equal(invalidScope.status, 400, '未知 scope 必须 400，不能静默按 both 处理');
  const missingProject = await downloadsRoute.GET(
    request(`https://studio.example.test/api/batch-production/batches/${seeded.batchId}/downloads`, userA),
    params(seeded.batchId),
  );
  assert.equal(missingProject.status, 400);

  // ---- 3. 请求别人的批次被拒绝 ----
  for (const url of [downloadsUrl(seeded.batchId, seeded.projectId), zipUrl(seeded.batchId, seeded.projectId)]) {
    const response = await (url.includes('/zip')
      ? zipRoute.GET(request(url, userB), params(seeded.batchId))
      : downloadsRoute.GET(request(url, userB), params(seeded.batchId)));
    assert.ok([403, 404].includes(response.status), `别人的批次必须被拒，实际 ${response.status}`);
    const text = await response.text();
    assert.equal(text.includes('ACC-CODE-01.mp4'), false, '拒绝响应不得泄露别人的文件名');
    assert.equal(text.includes('ACC-CODE-20261101'), false, '拒绝响应不得泄露别人的导出目录名');
  }
  // 伪造 projectId 也不行：batch scope 与 projectId 必须同属一个归属根。
  const forged = await downloadsRoute.GET(
    request(downloadsUrl(seeded.batchId, 'project-does-not-exist'), userA), params(seeded.batchId),
  );
  assert.ok([403, 404].includes(forged.status), `伪造 projectId 必须被拒，实际 ${forged.status}`);

  // ---- 4. ZIP 内容与清单一致：解压比对文件名与字节数 ----
  for (const scope of ['both', 'video', 'cover']) {
    const query = `&scope=${scope}`;
    const scopeManifest = await readManifest(await downloadsRoute.GET(request(downloadsUrl(seeded.batchId, seeded.projectId, query), userA), params(seeded.batchId)));
    const zipResponse = await zipRoute.GET(
      request(zipUrl(seeded.batchId, seeded.projectId, query), userA), params(seeded.batchId),
    );
    assert.equal(zipResponse.status, 200, await zipResponse.clone().text());
    assert.equal(zipResponse.headers.get('Content-Type'), 'application/zip');
    assert.equal(zipResponse.headers.get('Cache-Control'), 'no-store');
    const zip = await JSZip.loadAsync(Buffer.from(await zipResponse.arrayBuffer()));
    const zipEntries = Object.values(zip.files).filter((entry) => !entry.dir);
    assert.deepEqual(
      zipEntries.map((entry) => entry.name).sort(),
      scopeManifest.items.map((item) => item.relativeName).sort(),
      `ZIP（${scope}）的文件名必须与清单逐项一致`,
    );
    for (const item of scopeManifest.items) {
      const entry = zip.file(item.relativeName);
      assert.ok(entry, `ZIP 缺清单项 ${item.relativeName}`);
      assert.equal((await entry.async('nodebuffer')).byteLength, item.byteSize,
        `ZIP 项 ${item.relativeName} 的实际字节数必须等于清单大小`);
    }
  }
  // ZIP 文件名带导出身份与范围，浏览器另存时看得懂。
  const namedZip = await zipRoute.GET(
    request(zipUrl(seeded.batchId, seeded.projectId, '&scope=video'), userA), params(seeded.batchId),
  );
  assert.match(decodeURIComponent(namedZip.headers.get('Content-Disposition') ?? ''), /ACC-CODE-20261101-成片-视频\.zip/);

  // ---- 5. 没有可下载成片：「还没有导出过的成片」 ----
  db.prepare(`UPDATE batch_output_plans SET currentArtifactId = NULL WHERE batchVersionId = ?`).run('bv-ACC');
  const emptyManifest = await readManifest(await downloadsRoute.GET(
    request(downloadsUrl(seeded.batchId, seeded.projectId), userA), params(seeded.batchId),
  ));
  assert.deepEqual(emptyManifest.items, []);
  assert.equal(emptyManifest.emptyMessage, '还没有导出过的成片');
  const emptyZip = await zipRoute.GET(
    request(zipUrl(seeded.batchId, seeded.projectId), userA), params(seeded.batchId),
  );
  assert.equal(emptyZip.status, 404);
  assert.equal(((await emptyZip.json()) as { message?: string }).message, '还没有导出过的成片');

  console.log('PASS: batch download manifest + ZIP routes enforce ownership and keep ZIP identical to the manifest');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}


