import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
const { runWithAccessContext, createLocalAccessContext } = await import('../lib/media-core/access-context.ts');
const { registerTeamDevice, listTeamDownloads } = await import('../lib/team-service/transfers/devices.ts');
const { softDeleteResource } = await import('../lib/team-service/lifecycle/index.ts');
const { reserveProjectExportTarget, publishReservedExportTarget, publishReservedSingleFile } = await import('../lib/final-edit/export-naming.ts');
const { registerPublishedArtifacts, ensurePackagedArtifactRegistered, registerSingleArtifact } = await import('../lib/final-edit/project-artifacts.ts');
const { registerPackagedArtifact, publishPackagedCover, publishPackagedResult, deletePackagedPublish } = await import('../lib/final-edit/packaging.ts');
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

  // 包装封面发布独立版本，失败回滚与重试均不得改写已登记的原封面。
  const linkedTarget = reserveProjectExportTarget(storageRoot, { ...identity, taskName: '包装联动封面' });
  const renderJobId = 'render-cover-version';
  const packagingJobId = 'packaging-cover-version';
  const renderDirectory = path.join(storageRoot, 'final-edits', 'jobs', renderJobId);
  const packagingRelativeDir = path.join('final-edits', 'jobs', packagingJobId);
  const packagingDirectory = path.join(storageRoot, packagingRelativeDir);
  fs.mkdirSync(renderDirectory, { recursive: true });
  fs.mkdirSync(packagingDirectory, { recursive: true });
  const rawCover = path.join(renderDirectory, 'cover.jpg');
  await sharp({ create: { width: 32, height: 48, channels: 3, background: '#204060' } }).jpeg().toFile(rawCover);
  const originalBytes = fs.readFileSync(rawCover);
  const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  const originalHash = sha256(originalBytes);
  await publishReservedSingleFile({ storageRoot, sourceRelativePath: path.relative(storageRoot, rawCover),
    targetRelativePath: linkedTarget.coverRelativePath, reservationRelativePath: linkedTarget.reservationRelativePath,
    invalidCode: 'render_artifact_invalid' });
  const rawOutput = { videoRelativePath: path.relative(storageRoot, internalVideo), coverRelativePath: path.relative(storageRoot, rawCover),
    publishedCoverRelativePath: linkedTarget.coverRelativePath, coverFilename: linkedTarget.coverFilename };
  db.prepare(`INSERT INTO final_edit_jobs
    (id, projectId, kind, status, phase, requestKey, inputSnapshotJson, outputJson, createdAt)
    VALUES (?, 'project-a', 'render', 'succeeded', 'succeeded', ?, '{}', ?, '2026-11-11')`)
    .run(renderJobId, renderJobId, JSON.stringify(rawOutput));
  runWithAccessContext(access, () => registerSingleArtifact(db, {
    id: `final-edit:${renderJobId}:cover`, projectId: 'project-a', kind: 'final_cover', displayName: linkedTarget.coverFilename,
    relativePath: linkedTarget.coverRelativePath, mimeType: 'image/jpeg', sourceJobId: renderJobId, createdAt: '2026-11-11',
  }));
  const readRenderOutput = () => JSON.parse(db.prepare('SELECT outputJson FROM final_edit_jobs WHERE id=?')
    .pluck().get(renderJobId) as string) as typeof rawOutput;
  const oldFile = db.prepare('SELECT id, sha256, version FROM team_files WHERE relativePath=?')
    .get(linkedTarget.coverRelativePath.replaceAll('\\', '/')) as { id: string; sha256: string; version: number };
  assert.equal(oldFile.sha256, originalHash);
  const packagingVideo = path.join(packagingDirectory, 'final-packaged.mp4');
  fs.writeFileSync(packagingVideo, 'packaged-cover-video');
  const publishCoverAttempt = async (color: string) => {
    const temporary = path.join(packagingDirectory, 'cover-packaged.tmp.jpg');
    await sharp({ create: { width: 32, height: 48, channels: 3, background: color } }).jpeg().toFile(temporary);
    const cover = runWithAccessContext(access, () => publishPackagedCover({ storageRoot, temporaryCoverPath: temporary,
      jobRelativeDir: packagingRelativeDir, coverFilename: linkedTarget.coverFilename, currentCoverRelativePath: linkedTarget.coverRelativePath }));
    assert.ok(cover, '团队发布返回独立封面版本');
    const video = await publishPackagedResult({ storageRoot, internalVideoRelativePath: path.relative(storageRoot, packagingVideo),
      exportTarget: linkedTarget, renderVideoRelativePath: rawOutput.videoRelativePath });
    return { ...video, ...cover };
  };
  const registerCoverAttempt = (published: Awaited<ReturnType<typeof publishCoverAttempt>>) => registerPackagedArtifact(db, {
    projectId: 'project-a', sourceJobId: packagingJobId, sourceRenderJobId: renderJobId,
    target: published, kind: 'final_video', createdAt: '2026-11-11',
  });
  const interrupted = await publishCoverAttempt('#ff6633');
  assert.notEqual(interrupted.coverRelativePath, linkedTarget.coverRelativePath);
  assert.throws(() => runWithAccessContext(access, () => db.transaction(() => {
    registerCoverAttempt(interrupted);
    throw new Error('simulate publication transaction failure');
  })()), /simulate publication transaction failure/);
  await deletePackagedPublish(storageRoot, interrupted);
  assert.equal(fs.existsSync(path.join(storageRoot, interrupted.coverRelativePath)), false);
  assert.equal(fs.existsSync(path.join(storageRoot, linkedTarget.reservationRelativePath)), true, '失败后恢复视频预留供重试');
  assert.equal(readRenderOutput().publishedCoverRelativePath, linkedTarget.coverRelativePath, '事务失败保留原封面指针');
  assert.equal(sha256(fs.readFileSync(path.join(storageRoot, linkedTarget.coverRelativePath))), originalHash);

  const packaged = await publishCoverAttempt('#44cc88');
  runWithAccessContext(access, () => db.transaction(() => registerCoverAttempt(packaged))());
  const publishedOutput = readRenderOutput();
  assert.equal(publishedOutput.publishedCoverRelativePath, packaged.coverRelativePath);
  assert.equal(publishedOutput.coverRelativePath, rawOutput.coverRelativePath, '原始渲染内部封面仍保留');
  assert.equal(sha256(fs.readFileSync(rawCover)), originalHash);
  assert.equal(sha256(fs.readFileSync(path.join(storageRoot, linkedTarget.coverRelativePath))), originalHash,
    '包装成功后旧 team_files 封面版本的实际字节保持哈希一致');
  const newFile = db.prepare('SELECT id, sha256, version FROM team_files WHERE relativePath=?')
    .get(packaged.coverRelativePath.replaceAll('\\', '/')) as { id: string; sha256: string; version: number };
  assert.equal(newFile.version, oldFile.version + 1);
  assert.notEqual(newFile.sha256, oldFile.sha256);
  const coverResponse = runWithAccessContext(access, () => mediaResponse(
    new Request('https://studio.example.test/api/final-edit-jobs/render-cover-version/cover?download=1'),
    publishedOutput.publishedCoverRelativePath, 'image/jpeg', publishedOutput.coverFilename,
  ));
  assert.equal(coverResponse.status, 200, '正常封面读取入口可以授权访问新版本');
  assert.equal(sha256(Buffer.from(await coverResponse.arrayBuffer())), newFile.sha256);
  assert.ok(coverResponse.headers.get('Content-Disposition')?.includes('attachment'));
  const coverDelivery = listTeamDownloads(db, actor, { deviceId: device.id }).items.find(item => item.manifest.fileId === newFile.id);
  assert.ok(coverDelivery, '包装封面新版本进入设备交付清单');
  assert.equal(coverDelivery.manifest.displayName, linkedTarget.coverFilename, '客户端交付保留与成片配对的原封面文件名');
  runWithAccessContext(access, () => db.transaction(() => registerCoverAttempt(packaged))());
  assert.equal(db.prepare('SELECT COUNT(*) FROM team_files WHERE relativePath=?').pluck()
    .get(packaged.coverRelativePath.replaceAll('\\', '/')), 1, '重复登记不会新增文件版本');
  const localDirectory = path.join(storageRoot, 'projects', 'local-export', '成片');
  fs.mkdirSync(localDirectory, { recursive: true });
  const localVideo = path.join(localDirectory, '本地成片.mp4');
  const localCover = path.join(localDirectory, '本地成片-封面.jpg');
  fs.writeFileSync(localVideo, 'local-packaged-video');
  fs.writeFileSync(localCover, originalBytes);
  const localTemporary = path.join(packagingDirectory, 'local-cover.tmp.jpg');
  await sharp({ create: { width: 32, height: 48, channels: 3, background: '#9966cc' } }).jpeg().toFile(localTemporary);
  const localPackagedBytes = fs.readFileSync(localTemporary);
  const localPublication = runWithAccessContext(createLocalAccessContext(), () => publishPackagedCover({
    storageRoot, temporaryCoverPath: localTemporary, jobRelativeDir: packagingRelativeDir,
    coverFilename: path.basename(localCover), currentCoverRelativePath: path.relative(storageRoot, localCover),
  }));
  assert.equal(localPublication, undefined, '本地保持现有原目录封面，不新增团队版本指针');
  assert.deepEqual(fs.readFileSync(localCover), localPackagedBytes, '本地同名封面更新为包装版');
  assert.equal(path.dirname(localCover), path.dirname(localVideo), '在文件夹中查看仍可成对取出视频与包装封面');
  assert.equal(fs.readFileSync(localVideo, 'utf8'), 'local-packaged-video');
  console.log('PASS: packaged covers preserve immutable originals, roll back safely, and publish readable versions');

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
