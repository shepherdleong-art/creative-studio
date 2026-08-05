import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  publishReservedExportTarget,
  releaseReservedExportTarget,
  reserveProjectExportTarget,
} from '../lib/final-edit/export-naming.ts';
import { formatShanghaiTaskDate } from '../lib/final-edit/export-identity.ts';
import { FinalEditError } from '../lib/final-edit/workspace.ts';
import { buildPublishedJobOutput, registerPublishedArtifacts } from '../lib/final-edit/project-artifacts.ts';
import { initFinalEditSchema } from '../lib/final-edit/schema.ts';
import type { ExportIdentity } from '../lib/final-edit/types.ts';
import { projectExportFolderSegment } from '../lib/project-export-folder.ts';

assert.equal(formatShanghaiTaskDate('2026-07-23 15:59:59'), '20260723', 'SQLite UTC 时间必须按上海时区转换');
assert.equal(formatShanghaiTaskDate('2026-07-23 16:00:00'), '20260724', '上海日期跨日边界必须稳定');
assert.equal(formatShanghaiTaskDate('2026-07-23T18:30:00+02:00'), '20260724', '带 offset 的 ISO 时间不得按运行机本地时区猜测');
assert.equal(formatShanghaiTaskDate('not-a-date'), '', '非法日期必须显式返回空值');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-project-artifacts-'));
try {
  const internalDir = path.join(storageRoot, 'final-edits', 'jobs', 'job-a');
  fs.mkdirSync(internalDir, { recursive: true });
  const internalVideo = path.join(internalDir, 'final.mp4');
  const internalCover = path.join(internalDir, 'cover.jpg');
  fs.writeFileSync(internalVideo, 'video-a');
  fs.writeFileSync(internalCover, 'cover-a');

  const identity: ExportIdentity = {
    projectId: 'project-a',
    taskName: '净水器主图任务',
    productCode: 'JSQ-A1',
    taskDate: '20260724',
  };
  const projectFolder = projectExportFolderSegment({ id: identity.projectId, name: identity.taskName });
  const first = reserveProjectExportTarget(storageRoot, identity);
  assert.equal(first.videoFilename, '成片-JSQ-A1-20260724.mp4');
  assert.equal(first.coverFilename, '成片-JSQ-A1-20260724-封面.jpg');
  assert.equal(first.displayDirectory, `工作台/${projectFolder}/成片/`);
  assert.equal(fs.existsSync(path.join(storageRoot, first.videoRelativePath)), false, '入队时不得暴露零字节假成片');
  assert.equal(fs.existsSync(path.join(storageRoot, first.coverRelativePath)), false, '入队时不得暴露零字节假封面');
  assert.ok(fs.existsSync(path.join(storageRoot, first.reservationRelativePath)), '成对预留必须只持有隐藏独占锁');

  const second = reserveProjectExportTarget(storageRoot, identity);
  assert.equal(second.videoFilename, '成片-JSQ-A1-20260724-02.mp4');
  assert.equal(second.coverFilename, '成片-JSQ-A1-20260724-02-封面.jpg');

  const blocked = new Set([path.join('projects', projectFolder, '成片', '成片-JSQ-A1-20260724-03.mp4')]);
  const third = reserveProjectExportTarget(storageRoot, identity, { blockedRelativePaths: blocked });
  assert.equal(third.videoFilename, '成片-JSQ-A1-20260724-04.mp4', '数据库仍登记的缺失文件也必须占用命名序号');

  const published = await publishReservedExportTarget({
    storageRoot,
    target: first,
    internalVideoRelativePath: path.relative(storageRoot, internalVideo),
    internalCoverRelativePath: path.relative(storageRoot, internalCover),
  });
  assert.deepEqual(published, first);
  assert.equal(fs.readFileSync(path.join(storageRoot, first.videoRelativePath), 'utf8'), 'video-a');
  assert.equal(fs.readFileSync(path.join(storageRoot, first.coverRelativePath), 'utf8'), 'cover-a');
  assert.equal(fs.readFileSync(internalVideo, 'utf8'), 'video-a', '发布后必须保留内部 job 视频');
  assert.equal(fs.readFileSync(internalCover, 'utf8'), 'cover-a', '发布后必须保留内部 job 封面');
  assert.equal(fs.existsSync(path.join(storageRoot, first.reservationRelativePath)), false, '发布成功必须释放预留锁');

  assert.deepEqual(await publishReservedExportTarget({
    storageRoot,
    target: first,
    internalVideoRelativePath: path.relative(storageRoot, internalVideo),
    internalCoverRelativePath: path.relative(storageRoot, internalCover),
  }), first, 'worker 在发布后崩溃并恢复时必须幂等识别已完成产物');

  const output = buildPublishedJobOutput({
    internal: { videoRelativePath: 'final-edits/jobs/job-a/final.mp4', coverRelativePath: 'final-edits/jobs/job-a/cover.jpg', durationSec: 3, width: 1080, height: 1440, fps: 24 },
    target: first,
  });
  assert.equal(output.videoRelativePath, 'final-edits/jobs/job-a/final.mp4', '兼容字段必须保留内部不可变产物');
  assert.equal(output.publishedVideoRelativePath, first.videoRelativePath);
  assert.equal(output.publishedCoverRelativePath, first.coverRelativePath);
  assert.equal(output.videoFilename, first.videoFilename);
  assert.equal(output.displayDirectory, first.displayDirectory);

  const db = new Database(':memory:');
  initFinalEditSchema(db);
  registerPublishedArtifacts(db, { projectId: identity.projectId, sourceJobId: 'job-a', target: first, createdAt: '2026-07-24T00:00:00.000Z' });
  registerPublishedArtifacts(db, { projectId: identity.projectId, sourceJobId: 'job-a', target: first, createdAt: '2026-07-24T00:00:01.000Z' });
  const artifacts = db.prepare(`SELECT projectId, kind, displayName, relativePath, mimeType, sourceJobId FROM project_artifacts ORDER BY kind`).all() as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 2, 'worker recovery 不得重复注册同一 job 的产物');
  assert.deepEqual(artifacts.map((artifact) => artifact.kind), ['final_cover', 'final_video']);
  assert.ok(artifacts.every((artifact) => artifact.projectId === identity.projectId && artifact.sourceJobId === 'job-a'));
  db.close();

  await assert.rejects(() => publishReservedExportTarget({
    storageRoot,
    target: second,
    internalVideoRelativePath: '../outside.mp4',
    internalCoverRelativePath: path.relative(storageRoot, internalCover),
  }), (error: unknown) => error instanceof FinalEditError && error.code === 'unsafe_path');

  releaseReservedExportTarget(storageRoot, second);
  releaseReservedExportTarget(storageRoot, third);
  assert.equal(fs.existsSync(path.join(storageRoot, second.videoRelativePath)), false);
  assert.equal(fs.existsSync(path.join(storageRoot, second.coverRelativePath)), false);
  assert.equal(fs.existsSync(path.join(storageRoot, second.reservationRelativePath)), false);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-export-outside-'));
  const symlinkIdentity: ExportIdentity = { ...identity, projectId: 'project-symlink', taskName: '链接任务' };
  const unsafeProjectDir = path.join(storageRoot, 'projects', projectExportFolderSegment({ id: symlinkIdentity.projectId, name: symlinkIdentity.taskName }));
  fs.mkdirSync(unsafeProjectDir, { recursive: true });
  fs.symlinkSync(outside, path.join(unsafeProjectDir, '成片'));
  assert.throws(() => reserveProjectExportTarget(storageRoot, symlinkIdentity), /符号链接|unsafe/i);
  fs.rmSync(outside, { recursive: true, force: true });
} finally {
  fs.rmSync(storageRoot, { recursive: true, force: true });
}

console.log('final-edit project artifact publication tests passed');
