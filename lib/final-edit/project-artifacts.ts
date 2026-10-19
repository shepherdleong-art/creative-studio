import type Database from 'better-sqlite3';
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
}
