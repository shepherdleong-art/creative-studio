import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

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
const { registerPublishedArtifacts } = await import('../lib/final-edit/project-artifacts.ts');
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
