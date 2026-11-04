import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensions = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
interface ResolvedModule { url: string; format?: string | null; shortCircuit?: boolean }
type NextResolve = (specifier: string, context?: unknown) => ResolvedModule;
const { registerHooks } = module as unknown as {
  registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule }) => void;
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-upload-business-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-upload-business',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'disabled',
});
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');
const { registerRootScope, assertScopeConsistency } = await import('../lib/team-service/resource-scopes.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-upload-business', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
const admin = await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-upload-business-password');
const createdUser = await service.createUser(admin, { employeeId: '0001', displayName: '甲', role: 'employee' });
const login = await service.login({ employeeId: '0001', password: createdUser.credential });
const principal = await service.changeOwnPassword(login.principal, createdUser.credential, 'employee-upload-business-password');
const user = { principal, cookie: sessionCookie(login.token).split(';', 1)[0] };

db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('provider-test', '测试', '', 'test-key', 'gpt-image-2')").run();
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-a', '项目甲', 'provider-test', 'gpt-image-2', '')").run();
registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: principal.userId });

const { ensureBatchSchemaReady } = await import('../lib/batch-production/schema.ts');
const { ensureCreativeCanvasSchemaReady } = await import('../lib/creative-canvas/schema.ts');
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
assert.notEqual((await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'batch-backups') })).state, 'compatibility_only');
assert.notEqual((await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'canvas-backups') })).state, 'compatibility_only');
assert.notEqual((await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'script-backups') })).state, 'compatibility_only');
db.prepare(`INSERT INTO creative_canvases (id, name, graphRevision, graphJson, viewportJson, createdAt, updatedAt)
  VALUES ('canvas-a', '画布甲', 0, '{"schemaVersion":1,"nodes":[],"edges":[]}', '{}', '2026-11-02', '2026-11-02')`).run();
registerRootScope(db, { resourceType: 'canvas', resourceId: 'canvas-a', ownerUserId: principal.userId });

const uploadsRoute = await import('../app/api/team/uploads/route.ts');
const partRoute = await import('../app/api/team/uploads/[id]/parts/[part]/route.ts');
const completeRoute = await import('../app/api/team/uploads/[id]/complete/route.ts');
const imageFileRoute = await import('../app/api/images/[...path]/route.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');

function request(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('Cookie', `${user.cookie}; __Host-team_csrf=csrf-test`);
  headers.set('Origin', 'https://studio.example.test');
  headers.set('x-csrf-token', 'csrf-test');
  return new Request(url, { ...init, headers });
}
const json = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } }) satisfies RequestInit;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function publish(input: {
  targetKind: string;
  targetScope: { resourceType: string; resourceId: string };
  usage: string;
  relativeName: string;
  mimeType: string;
  bytes: Buffer;
  idempotencyKey: string;
  imageOptions?: { role: "input" | "reference"; usage: string; preprocessEnabled: boolean; targetMaxSide: number; jpegQuality: number };
  beforeComplete?: () => void;
  expectedCompleteStatus?: number;
}) {
  const partSize = 512 * 1024;
  assert.ok(input.bytes.length > partSize, `${input.targetKind} 必须使用真实多分片内容`);
  const createdResponse = await uploadsRoute.POST(request('https://studio.example.test/api/team/uploads', {
    method: 'POST', ...json({
      targetKind: input.targetKind,
      imageOptions: input.imageOptions,
      targetScope: input.targetScope,
      usage: input.usage,
      relativeName: input.relativeName,
      mimeType: input.mimeType,
      expectedSize: input.bytes.length,
      expectedSha256: sha256(input.bytes),
      sourceFingerprint: `${input.idempotencyKey}-source`,
      idempotencyKey: input.idempotencyKey,
      partSize,
    }),
  }));
  assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
  const created = await createdResponse.json();
  assert.ok(created.missingParts.length >= 2);
  for (const partNumber of created.missingParts as number[]) {
    const start = (partNumber - 1) * partSize;
    const part = input.bytes.subarray(start, Math.min(start + partSize, input.bytes.length));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < part.length; offset += 17 * 1024) {
          controller.enqueue(part.subarray(offset, Math.min(offset + 17 * 1024, part.length)));
        }
        controller.close();
      },
    });
    const response = await partRoute.PUT(request(`https://studio.example.test/api/team/uploads/${created.uploadId}/parts/${partNumber}`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
    } as RequestInit), { params: Promise.resolve({ id: created.uploadId, part: String(partNumber) }) });
    assert.equal(response.status, 200, await response.clone().text());
  }
  input.beforeComplete?.();
  const completedResponse = await completeRoute.POST(request(`https://studio.example.test/api/team/uploads/${created.uploadId}/complete`, {
    method: 'POST', ...json({ expectedSha256: sha256(input.bytes) }),
  }), { params: Promise.resolve({ id: created.uploadId }) });
  assert.equal(completedResponse.status, input.expectedCompleteStatus ?? 200, await completedResponse.clone().text());
  const completed = await completedResponse.json();
  if (completedResponse.status !== 200) return { ...completed, uploadId: created.uploadId };
  const replayResponse = await completeRoute.POST(request(`https://studio.example.test/api/team/uploads/${created.uploadId}/complete`, {
    method: 'POST', ...json({}),
  }), { params: Promise.resolve({ id: created.uploadId }) });
  assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
  const replay = await replayResponse.json();
  assert.equal(replay.resultResourceType, completed.resultResourceType);
  assert.equal(replay.resultResourceId, completed.resultResourceId);
  assert.equal(replay.file.fileId, completed.file.fileId);
  return completed;
}

function assertManagedPublication(fileId: string, resourceType: string, resourceId: string) {
  const file = db.prepare("SELECT * FROM team_files WHERE id = ? AND state = 'ready'").get(fileId) as { relativePath: string; byteSize: number };
  assert.ok(file, '业务发布必须同时把原 team_file 置为 ready');
  assert.equal(fs.existsSync(path.join(root, 'storage', file.relativePath)), true, 'ready 文件必须存在于受管位置');
  const reference = db.prepare(`SELECT role FROM team_file_references
    WHERE fileId = ? AND resourceType = ? AND resourceId = ? AND releasedAt IS NULL`).get(fileId, resourceType, resourceId) as { role: string } | undefined;
  assert.equal(reference?.role, 'input');
  return file;
}

try {
  const png = await sharp(randomBytes(768 * 768 * 3), {
    raw: { width: 768, height: 768, channels: 3 },
  }).png().toBuffer();
  assert.ok(png.length > 1024 * 1024, 'PNG 必须大于 1 MiB，避免假大文件');

  const normal = await publish({
    targetKind: 'project_image', targetScope: { resourceType: 'project', resourceId: 'project-a' },
    usage: 'image', relativeName: '产品/原始.png', mimeType: 'image/png', bytes: png, idempotencyKey: 'normal-image-v1',
  });
  assert.equal(normal.resultResourceType, 'image');
  const image = db.prepare('SELECT * FROM image_assets WHERE id = ? AND projectId = ?').get(normal.resultResourceId, 'project-a') as {
    id: string; path: string; originalPath: string; originalWidth: number; originalHeight: number;
  };
  assert.ok(image, 'complete 必须创建普通项目 image_assets 实体');
  assert.equal(image.originalWidth, 768);
  assert.equal(image.originalHeight, 768);
  const normalFile = assertManagedPublication(normal.file.fileId, 'image', image.id);
  assert.equal(image.path, path.join(root, 'storage', normalFile.relativePath));
  assert.equal(image.originalPath, image.path);
  assert.equal(assertScopeConsistency(db, 'image', image.id).rootId, 'project-a');
  for (const usage of ['scene_seed', 'shot_source', 'video_tail_frame']) {
    const result = await publish({
      targetKind: 'project_image', targetScope: { resourceType: 'project', resourceId: 'project-a' },
      usage: 'image', relativeName: `${usage}.png`, mimeType: 'image/png', bytes: png,
      idempotencyKey: `browser-${usage}`,
      imageOptions: { role: 'input', usage, preprocessEnabled: true, targetMaxSide: 512, jpegQuality: 85 },
    });
    const stored = db.prepare('SELECT * FROM image_assets WHERE id=?').get(result.resultResourceId) as {
      usage: string; role: string; processedPath: string; processedWidth: number; preprocessingEnabled: number;
    };
    assert.equal(stored.usage, usage);
    assert.equal(stored.role, 'input');
    assert.equal(stored.processedWidth, 512);
    assert.equal(stored.preprocessingEnabled, 1);
    assert.equal(result.uploadedFile.usage, usage);
    assert.equal(result.uploadedFile.path, undefined, '不向客户端暴露服务器绝对路径');
    assert.ok(result.uploadedFile.imageUrl.startsWith('/api/images/'));
    const previewSegments = result.uploadedFile.relativePath.split('/');
    const preview = await imageFileRoute.GET(request(`https://studio.example.test${result.uploadedFile.imageUrl}`) as never,
      { params: Promise.resolve({ path: previewSegments }) });
    assert.equal(preview.status, 200, await preview.clone().text());
    assert.equal(preview.headers.get('content-type'), 'image/jpeg');
    await preview.arrayBuffer();
    const derived = db.prepare("SELECT id FROM team_files WHERE derivedFromFileId=? AND state='ready'").get(result.file.fileId) as {id: string};
    assert.ok(derived, '预处理图必须登记为可读取的受管派生文件');
  }

  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM image_assets WHERE id = ?").pluck().get(image.id)), 1, '重放 complete 不得重复建普通素材');

  const videoPath = path.join(root, 'batch-source.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=640x480:rate=24',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', '-y', videoPath,
  ]);
  const video = fs.readFileSync(videoPath);
  assert.ok(video.length > 1024 * 1024, '批量视频必须使用真实大于 1 MiB 的多分片内容');
  const batch = await publish({
    targetKind: 'batch_asset', targetScope: { resourceType: 'project', resourceId: 'project-a' },
    usage: 'batch_asset', relativeName: '批量/视频.mp4', mimeType: 'video/mp4', bytes: video, idempotencyKey: 'batch-asset-v1',
  });
  assert.equal(batch.resultResourceType, 'batch_asset');
  const batchAsset = db.prepare('SELECT * FROM batch_assets WHERE id = ? AND projectId = ?').get(batch.resultResourceId, 'project-a') as {
    id: string; contentFingerprint: string; mediaJson: string;
  };
  assert.ok(batchAsset, 'complete 必须创建项目批量素材实体');
  assert.equal(batchAsset.contentFingerprint, `sha256:${sha256(video)}`);
  assert.equal(JSON.parse(batchAsset.mediaJson).width, 640);
  const batchSource = db.prepare(`SELECT * FROM batch_asset_sources WHERE assetId = ? AND sourceKind = 'managed'`).get(batchAsset.id) as {
    locationJson: string; health: string;
  };
  assert.ok(batchSource, '批量素材必须有真实 managed 来源');
  const batchLocation = JSON.parse(batchSource.locationJson) as { kind: string; relativePath: string };
  assert.equal(batchLocation.kind, 'managed');
  assert.equal(fs.existsSync(path.join(root, batchLocation.relativePath)), true);
  assertManagedPublication(batch.file.fileId, 'batch_asset', batchAsset.id);
  assert.equal(assertScopeConsistency(db, 'batch_asset', batchAsset.id).rootId, 'project-a');
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM batch_assets WHERE id = ?").pluck().get(batchAsset.id)), 1);

  const canvas = await publish({
    targetKind: 'canvas_asset', targetScope: { resourceType: 'canvas', resourceId: 'canvas-a' },
    usage: 'canvas_asset', relativeName: '画布/素材.png', mimeType: 'image/png', bytes: png, idempotencyKey: 'canvas-asset-v1',
  });
  assert.equal(canvas.resultResourceType, 'canvas_asset');
  const canvasAsset = db.prepare('SELECT * FROM creative_canvas_assets WHERE id = ? AND canvasId = ?').get(canvas.resultResourceId, 'canvas-a') as {
    id: string; relativePath: string; contentHash: string; width: number; height: number; ready: number;
  };
  assert.ok(canvasAsset, 'complete 必须创建画布素材实体');
  assert.equal(canvasAsset.contentHash, sha256(png));
  assert.equal(canvasAsset.width, 768);
  assert.equal(canvasAsset.height, 768);
  assert.equal(canvasAsset.ready, 1);
  assert.equal(fs.existsSync(path.join(root, 'storage', canvasAsset.relativePath)), true);
  assertManagedPublication(canvas.file.fileId, 'canvas_asset', canvasAsset.id);
  assert.equal(assertScopeConsistency(db, 'canvas_asset', canvasAsset.id).rootId, 'canvas-a');
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM creative_canvas_assets WHERE id = ?").pluck().get(canvasAsset.id)), 1);

  const detail = await publish({
    targetKind: 'detail_page_source', targetScope: { resourceType: 'project', resourceId: 'project-a' },
    usage: 'detail_page', relativeName: '详情页/page-1.png', mimeType: 'image/png', bytes: png, idempotencyKey: 'detail-source-v1',
  });
  assert.equal(detail.resultResourceType, 'script_source_set');
  const sourceSet = db.prepare('SELECT * FROM script_studio_source_sets WHERE id = ? AND projectId = ?').get(detail.resultResourceId, 'project-a') as {
    id: string; imageAssetIdsJson: string;
  };
  assert.ok(sourceSet, '详情页 complete 必须创建真实来源集');
  const detailImageIds = JSON.parse(sourceSet.imageAssetIdsJson) as string[];
  assert.equal(detailImageIds.length, 1);
  const detailImage = db.prepare("SELECT * FROM image_assets WHERE id = ? AND projectId = 'project-a' AND usage = 'detail_page'").get(detailImageIds[0]) as {
    id: string; originalWidth: number; originalHeight: number;
  };
  assert.ok(detailImage, '详情页来源集必须关联同事务创建的 image_assets');
  assert.equal(detailImage.originalWidth, 768);
  assertManagedPublication(detail.file.fileId, 'image', detailImage.id);
  assertManagedPublication(detail.file.fileId, 'script_source_set', sourceSet.id);
  assert.equal(assertScopeConsistency(db, 'image', detailImage.id).rootId, 'project-a');
  assert.equal(assertScopeConsistency(db, 'script_source_set', sourceSet.id).rootId, 'project-a');
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM script_studio_source_sets WHERE id = ?").pluck().get(sourceSet.id)), 1);

  const beforeAtomicImages = (db.prepare("SELECT COUNT(*) AS count FROM image_assets WHERE projectId = 'project-a'").pluck().get() as number);
  const atomicFailure = await publish({
    targetKind: 'project_image', targetScope: { resourceType: 'project', resourceId: 'project-a' },
    usage: 'image', relativeName: '产品/原子回滚.png', mimeType: 'image/png', bytes: png, idempotencyKey: 'atomic-image-v1',
    expectedCompleteStatus: 409,
    beforeComplete: () => db.exec(`CREATE TRIGGER fail_business_file_reference
      BEFORE INSERT ON team_file_references WHEN NEW.resourceType = 'image'
      BEGIN SELECT RAISE(ABORT, 'injected business reference failure'); END;`),
  });
  db.exec('DROP TRIGGER fail_business_file_reference');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_assets WHERE projectId = 'project-a'").pluck().get(), beforeAtomicImages,
    '引用登记失败必须回滚业务实体与 scope');
  const staged = db.prepare(`SELECT f.state, f.relativePath, u.resultResourceId
    FROM team_uploads u JOIN team_files f ON f.id = u.fileId WHERE u.id = ?`).get(atomicFailure.uploadId) as {
      state: string; relativePath: string; resultResourceId: string | null;
    };
  assert.equal(staged.state, 'staged');
  assert.equal(staged.resultResourceId, null);
  assert.equal(fs.existsSync(path.join(root, 'storage', staged.relativePath)), true, '回滚后受管文件必须保留供对账重试');
  const retryResponse = await completeRoute.POST(request(`https://studio.example.test/api/team/uploads/${atomicFailure.uploadId}/complete`, {
    method: 'POST', ...json({}),
  }), { params: Promise.resolve({ id: atomicFailure.uploadId }) });
  assert.equal(retryResponse.status, 200, await retryResponse.clone().text());
  const retried = await retryResponse.json();
  assert.equal(retried.resultResourceType, 'image');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_assets WHERE projectId = 'project-a'").pluck().get(), beforeAtomicImages + 1);
  assertManagedPublication(retried.file.fileId, 'image', retried.resultResourceId);

  console.log('PASS: controlled upload publishes four business kinds with atomic rollback and idempotent replay');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
