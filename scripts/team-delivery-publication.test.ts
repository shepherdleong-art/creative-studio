import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import sharp from 'sharp';

register('./typescript-extension-loader.mjs', import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-delivery-publication-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-delivery-publication',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'disabled',
});
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { registerRootScope, registerInheritedScope, createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { registerTeamDevice, listTeamDownloads } = await import('../lib/team-service/transfers/devices.ts');
const { softDeleteResource } = await import('../lib/team-service/lifecycle/index.ts');
const { reserveProjectExportTarget, publishReservedExportTarget } = await import('../lib/final-edit/export-naming.ts');
const { registerPublishedArtifacts, ensurePackagedArtifactRegistered } = await import('../lib/final-edit/project-artifacts.ts');
const { registerPackagedArtifact } = await import('../lib/final-edit/packaging.ts');
const { mediaResponse } = await import('../lib/final-edit/media-response.ts');
const { initFinalEditSchema } = await import('../lib/final-edit/schema.ts');
const { ensureCreativeCanvasSchemaReady } = await import('../lib/creative-canvas/schema.ts');
const { registerCanvasResultAsset } = await import('../lib/creative-canvas/assets.ts');
const { createCanvasExport } = await import('../lib/creative-canvas/export.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-delivery-publication', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
initFinalEditSchema(db);
assert.notEqual((await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'canvas-backups') })).state, 'compatibility_only');
const actor = { userId: 'user-a', role: 'employee' as const };
db.prepare(`INSERT INTO team_users (
  id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
) VALUES (?, ?, ?, 'employee', 'active', 'test', 0, 1, '2026-11-02', '2026-11-02')`).run(actor.userId, '0001', '甲');
db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('provider-test', '测试', '', 'test-key', 'gpt-image-2')").run();
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-a', '项目甲', 'provider-test', 'gpt-image-2', '')").run();
registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: actor.userId });
db.prepare(`INSERT INTO creative_canvases (id, name, graphRevision, graphJson, viewportJson, createdAt, updatedAt)
  VALUES ('canvas-a', '画布甲', 0, '{"schemaVersion":1,"nodes":[],"edges":[]}', '{}', '2026-11-02', '2026-11-02')`).run();
registerRootScope(db, { resourceType: 'canvas', resourceId: 'canvas-a', ownerUserId: actor.userId });
const access = createTeamAccessContext({ db, principal: actor });
const storageRoot = path.join(root, 'storage');
const device = registerTeamDevice(db, actor, {
  deploymentId: 'deployment-a', clientDeviceId: 'device-a', displayName: '原设备', platform: 'win32-x64',
});

try {
  const identity = {
    projectId: 'project-a', taskName: '正式成片', productCode: 'P-1', taskDate: '20261102', exportDirName: 'project-a',
  };
  const target = reserveProjectExportTarget(storageRoot, identity);
  const internalDirectory = path.join(storageRoot, 'final-edits', 'jobs', 'job-a');
  fs.mkdirSync(internalDirectory, { recursive: true });
  const internalVideo = path.join(internalDirectory, 'final.mp4');
  const internalCover = path.join(internalDirectory, 'cover.jpg');
  fs.writeFileSync(internalVideo, 'real-published-video');
  fs.writeFileSync(internalCover, 'real-published-cover');
  await publishReservedExportTarget({
    storageRoot,
    target,
    internalVideoRelativePath: path.relative(storageRoot, internalVideo),
    internalCoverRelativePath: path.relative(storageRoot, internalCover),
  });
  runWithAccessContext(access, () => registerPublishedArtifacts(db, {
    projectId: 'project-a', sourceJobId: 'job-a', target, createdAt: '2026-11-02T00:00:00.000Z',
  }));
  const projectFiles = db.prepare(`SELECT f.id, f.version, f.relativePath FROM team_files f
    JOIN team_file_references r ON r.fileId = f.id AND r.role = 'output'
    WHERE r.resourceType = 'project_artifact' ORDER BY f.relativePath`).all() as Array<{ id: string; version: number; relativePath: string }>;
  assert.equal(projectFiles.length, 2);
  const projectDownloads = listTeamDownloads(db, actor, { deviceId: device.id }).items;
  assert.deepEqual(projectDownloads.map((item) => item.manifest.fileId).sort(), projectFiles.map((file) => file.id).sort(),
    '普通成片 output 发布必须进入原设备自动交付清单');
  for (const item of projectDownloads) {
    const file = projectFiles.find((candidate) => candidate.id === item.manifest.fileId)!;
    assert.equal(item.manifest.version, file.version);
    assert.equal(item.sourceResource.resourceType, 'project_artifact');
  }

  // 包装联动与独立包装都必须走完整发布登记，否则 video 接口在文件授权时失败。
  for (const kind of ['final_video', 'packaged_video'] as const) {
    const relativePath = `projects/project-a/${kind}.mp4`;
    const bytes = Buffer.from(`packaged-video-${kind}`);
    fs.mkdirSync(path.dirname(path.join(storageRoot, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, relativePath), bytes);
    const publish = () => registerPackagedArtifact(db, {
      projectId: 'project-a', sourceJobId: `job-${kind}`, kind,
      target: { videoRelativePath: relativePath, videoFilename: `${kind}.mp4`, displayDirectory: 'project-a' },
      createdAt: '2026-11-11T00:00:00.000Z',
    });
    runWithAccessContext(access, publish);
    const response = runWithAccessContext(access, () => mediaResponse(
      new Request(`https://studio.example.test/api/final-edit-jobs/job-${kind}/video`, {
        headers: { Range: 'bytes=0-7' },
      }), relativePath, 'video/mp4',
    ));
    assert.equal(response.status, 206, `${kind}: 正式成片预览必须支持 Range`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 8));
    const file = db.prepare("SELECT id, version FROM team_files WHERE relativePath=? AND state='ready'")
      .get(relativePath) as { id: string; version: number };
    assert.ok(listTeamDownloads(db, actor, { deviceId: device.id }).items.some(item => item.manifest.fileId === file.id),
      `${kind}: 包装版必须进入设备交付清单`);
    runWithAccessContext(access, publish);
    const readyCount = db.prepare("SELECT COUNT(*) AS n FROM team_files WHERE relativePath=? AND state='ready'")
      .get(relativePath) as { n: number };
    assert.equal(readyCount.n, 1, '重复登记不得产生第二份 ready 文件');
    const otherAccess = createTeamAccessContext({ db, principal: { userId: 'other-user', role: 'employee' } });
    assert.throws(() => runWithAccessContext(otherAccess, () => mediaResponse(
      new Request('https://studio.example.test/preview'), relativePath, 'video/mp4',
    )), /不存在或不可用/, '其他员工不能读取包装成片');
  }

  // 线上旧包装任务已经有正式产物行，但缺 scope + file；打开预览即可补登，无需重新渲染。
  const legacyPath = 'projects/project-a/legacy-packaged.mp4';
  fs.writeFileSync(path.join(storageRoot, legacyPath), 'legacy-packaged-video');
  db.prepare(`INSERT INTO project_artifacts
    (id, projectId, kind, displayName, relativePath, mimeType, sourceJobId, createdAt)
    VALUES ('legacy-video', 'project-a', 'final_video', 'legacy.mp4', ?, 'video/mp4', 'legacy-job', '2026-11-10')`).run(legacyPath);
  const repair = () => ensurePackagedArtifactRegistered(db, {
    projectId: 'project-a', sourceJobId: 'legacy-job', relativePath: legacyPath,
  });
  const legacyResponse = () => mediaResponse(new Request('https://studio.example.test/legacy', {
    headers: { Range: 'bytes=0-5' },
  }), legacyPath, 'video/mp4');
  assert.throws(() => runWithAccessContext(access, legacyResponse), /不存在或不可用/);
  const otherAccess = createTeamAccessContext({ db, principal: { userId: 'other-user', role: 'employee' } });
  assert.throws(() => runWithAccessContext(otherAccess, repair), /不存在|无权/);
  runWithAccessContext(access, () => ensurePackagedArtifactRegistered(db, {
    projectId: 'project-a', sourceJobId: 'unrelated-job', relativePath: legacyPath,
  }));
  assert.throws(() => runWithAccessContext(access, legacyResponse), /不存在或不可用/, '不能按路径猜测其他任务的成片');
  runWithAccessContext(access, repair);
  const recovered = runWithAccessContext(access, legacyResponse);
  assert.equal(recovered.status, 206);
  assert.equal(await recovered.text(), 'legacy');
  runWithAccessContext(access, repair);
  db.prepare("UPDATE team_resource_scopes SET deletedAt='2026-11-11' WHERE resourceType='project_artifact' AND resourceId='legacy-video'").run();
  runWithAccessContext(access, repair);
  assert.throws(() => runWithAccessContext(access, legacyResponse), /不存在或不可用/, '补登不能恢复已删除的成片');

  db.prepare(`INSERT INTO creative_canvas_tasks (
    id, runId, canvasId, nodeId, nodeEpoch, mediaKind, phase, providerSnapshot, parameterSnapshot,
    submissionState, slotHeld, fence, pollCount, createdAt, updatedAt
  ) VALUES ('formal-task-a', NULL, 'canvas-a', 'node-a', 0, 'image', 'succeeded', '{}', '{}',
    'terminal', 0, 1, 0, '2026-11-02', '2026-11-02')`).run();
  registerInheritedScope(db, {
    resourceType: 'canvas_task', resourceId: 'formal-task-a',
    parent: { resourceType: 'canvas', resourceId: 'canvas-a' },
  });
  const generated = await runWithAccessContext(access, async () => registerCanvasResultAsset({
    db,
    canvasId: 'canvas-a',
    storageRoot,
    taskId: 'formal-task-a',
    mediaKind: 'image',
    mimeType: 'image/png',
    data: await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 20, g: 80, b: 120 } } }).png().toBuffer(),
  }));
  const generatedFile = db.prepare('SELECT id FROM team_files WHERE relativePath = ?').get(generated.relativePath) as { id: string };
  assert.equal(listTeamDownloads(db, actor, { deviceId: device.id }).items.some((item) => item.manifest.fileId === generatedFile.id), false,
    '画布生成正式版 output 不得自动下载');
  const graph = {
    schemaVersion: 1,
    nodes: [{
      id: 'node-a', kind: 'image-generation', position: { x: 0, y: 0 },
      data: { title: '正式结果', modelKey: null, generationMode: 'text-to-image', prompt: '', parameters: {}, references: [], referenceLabelCounter: 0 },
    }],
    edges: [],
  };
  db.prepare('UPDATE creative_canvases SET graphJson = ? WHERE id = ?').run(JSON.stringify(graph), 'canvas-a');
  db.prepare(`INSERT INTO creative_canvas_node_states (
    canvasId, nodeId, nodeEpoch, currentAssetId, resultTaskId, createdAt, updatedAt
  ) VALUES ('canvas-a', 'node-a', 0, ?, 'formal-task-a', '2026-11-02', '2026-11-02')`).run(generated.id);
  const exported = await runWithAccessContext(access, () => createCanvasExport({
    db, canvasId: 'canvas-a', storageRoot, nodeIds: ['node-a'],
  }));
  const zipFile = db.prepare('SELECT id, version FROM team_files WHERE relativePath = ?').get(exported.zipRelativePath) as { id: string; version: number };
  const afterExport = listTeamDownloads(db, actor, { deviceId: device.id }).items;
  const zipDelivery = afterExport.find((item) => item.manifest.fileId === zipFile.id);
  assert.ok(zipDelivery, '用户主动打包的画布 ZIP export 必须进入设备交付清单');
  assert.equal(zipDelivery.manifest.version, zipFile.version);
  assert.equal(zipDelivery.sourceResource.resourceType, 'canvas_export');
  assert.equal(afterExport.some((item) => item.manifest.fileId === generatedFile.id), false,
    '主动打包只能交付 ZIP，不能连带自动交付画布正式生成结果');

  softDeleteResource(db, actor, { resourceType: 'project', resourceId: 'project-a' });
  const suppressed = listTeamDownloads(db, actor, { deviceId: device.id }).items;
  for (const file of projectFiles) {
    assert.equal(suppressed.find((item) => item.manifest.fileId === file.id)?.deliveryState, 'suppressed',
      '已删项目的真实成片必须抑制自动交付');
  }
  assert.notEqual(suppressed.find((item) => item.manifest.fileId === zipFile.id)?.deliveryState, 'suppressed');

  console.log('PASS: real project output and canvas export publish versioned device delivery without auto-delivering canvas results');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
