import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { registerManagedFile, requireAccessContext } from '../media-core/access-context.ts';
import type { ReservedProjectExportTarget } from './export-naming.ts';

export interface InternalRenderOutput {
  videoRelativePath: string;
  coverRelativePath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}

export interface PublishedFinalEditJobOutput extends InternalRenderOutput {
  publishedVideoRelativePath: string;
  publishedCoverRelativePath: string;
  videoFilename: string;
  coverFilename: string;
  displayDirectory: string;
}

export function buildPublishedJobOutput(input: {
  internal: InternalRenderOutput;
  target: ReservedProjectExportTarget;
}): PublishedFinalEditJobOutput {
  return {
    ...input.internal,
    publishedVideoRelativePath: input.target.videoRelativePath,
    publishedCoverRelativePath: input.target.coverRelativePath,
    videoFilename: input.target.videoFilename,
    coverFilename: input.target.coverFilename,
    displayDirectory: input.target.displayDirectory,
  };
}

/** 单条产物登记（包装联动：渲染任务只发布封面、包装任务发布视频时分别使用）。 */
export function registerSingleArtifact(db: Database.Database, input: {
  id: string;
  projectId: string;
  kind: string;
  displayName: string;
  relativePath: string;
  mimeType: string;
  sourceJobId: string;
  createdAt: string;
}): void {
  db.prepare(`DELETE FROM project_artifacts WHERE projectId=? AND relativePath=? AND COALESCE(sourceJobId, '')<>?`).run(input.projectId, input.relativePath, input.sourceJobId);
  db.prepare(`
    INSERT INTO project_artifacts
      (id, projectId, kind, displayName, relativePath, mimeType, sourceJobId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sourceJobId, kind) DO UPDATE SET
      projectId=excluded.projectId,
      displayName=excluded.displayName,
      relativePath=excluded.relativePath,
      mimeType=excluded.mimeType
  `).run(input.id, input.projectId, input.kind, input.displayName, input.relativePath, input.mimeType, input.sourceJobId, input.createdAt);
  const access = requireAccessContext();
  access.registerInheritedScope({
    resourceType: 'project_artifact', resourceId: input.id,
    parent: { resourceType: 'project', resourceId: input.projectId },
  });
  if (access.kind === 'team') {
    registerManagedFile({
      absolutePath: path.join(dataRoot(), 'storage', input.relativePath),
      mimeType: input.mimeType,
      seriesId: `project-artifact:${input.id}`,
      references: [
        { resourceType: 'project_artifact', resourceId: input.id, role: 'output' },
        { resourceType: 'project_artifact', resourceId: input.id, role: 'delivery' },
      ],
    });
  }
}

/** 兼容旧包装任务漏登的产物；只补当前项目中已存在、且从未登记过的确切产物。 */
export function ensurePackagedArtifactRegistered(db: Database.Database, input: {
  projectId: string;
  sourceJobId: string;
  relativePath: string;
}): void {
  const access = requireAccessContext();
  if (access.kind !== 'team') return;
  access.assertAccess('project', input.projectId, 'read');
  const storageRoot = path.join(dataRoot(), 'storage');
  const absolutePath = path.resolve(storageRoot, input.relativePath);
  const artifact = (db.prepare(`SELECT id, relativePath FROM project_artifacts
    WHERE projectId=? AND sourceJobId=? AND kind IN ('final_video', 'packaged_video') AND mimeType='video/mp4'`)
    .all(input.projectId, input.sourceJobId) as Array<{ id: string; relativePath: string }>)
    .find(row => path.resolve(storageRoot, row.relativePath) === absolutePath);
  if (!artifact) return;
  const relativePath = path.relative(storageRoot, absolutePath).split(path.sep).join('/');
  // 已有 scope 或文件记录意味着它已走过登记/生命周期管理，不能在读取时复活撤回或清理的文件。
  if (db.prepare("SELECT 1 FROM team_resource_scopes WHERE resourceType='project_artifact' AND resourceId=?").get(artifact.id)
    || db.prepare('SELECT 1 FROM team_files WHERE relativePath=?').get(relativePath)) return;
  access.assertAccess('project', input.projectId, 'write');
  db.transaction(() => {
    access.registerInheritedScope({
      resourceType: 'project_artifact', resourceId: artifact.id,
      parent: { resourceType: 'project', resourceId: input.projectId },
    });
    registerManagedFile({
      absolutePath, mimeType: 'video/mp4', seriesId: `project-artifact:${artifact.id}`,
      references: [
        { resourceType: 'project_artifact', resourceId: artifact.id, role: 'output' },
        { resourceType: 'project_artifact', resourceId: artifact.id, role: 'delivery' },
      ],
    });
  })();
}

export function registerPublishedArtifacts(db: Database.Database, input: {
  projectId: string;
  sourceJobId: string;
  target: ReservedProjectExportTarget;
  createdAt: string;
}): void {
  db.prepare(`DELETE FROM project_artifacts WHERE projectId=? AND relativePath IN (?, ?) AND COALESCE(sourceJobId, '')<>?`).run(
    input.projectId,
    input.target.videoRelativePath,
    input.target.coverRelativePath,
    input.sourceJobId,
  );
  const upsert = db.prepare(`
    INSERT INTO project_artifacts
      (id, projectId, kind, displayName, relativePath, mimeType, sourceJobId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sourceJobId, kind) DO UPDATE SET
      projectId=excluded.projectId,
      displayName=excluded.displayName,
      relativePath=excluded.relativePath,
      mimeType=excluded.mimeType
  `);
  upsert.run(`final-edit:${input.sourceJobId}:video`, input.projectId, 'final_video', input.target.videoFilename, input.target.videoRelativePath, 'video/mp4', input.sourceJobId, input.createdAt);
  upsert.run(`final-edit:${input.sourceJobId}:cover`, input.projectId, 'final_cover', input.target.coverFilename, input.target.coverRelativePath, 'image/jpeg', input.sourceJobId, input.createdAt);
  const access = requireAccessContext();
  for (const kind of ['video', 'cover'] as const) {
    access.registerInheritedScope({
      resourceType: 'project_artifact', resourceId: `final-edit:${input.sourceJobId}:${kind}`,
      parent: { resourceType: 'project', resourceId: input.projectId },
    });
    if (access.kind === 'team') {
      const relativePath = kind === 'video' ? input.target.videoRelativePath : input.target.coverRelativePath;
      registerManagedFile({
        absolutePath: path.join(dataRoot(), 'storage', relativePath),
        mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
        seriesId: `project-artifact:final-edit:${input.sourceJobId}:${kind}`,
        references: [
          { resourceType: 'project_artifact', resourceId: `final-edit:${input.sourceJobId}:${kind}`, role: 'output' },
          { resourceType: 'project_artifact', resourceId: `final-edit:${input.sourceJobId}:${kind}`, role: 'delivery' },
        ],
      });
    }
  }
}
