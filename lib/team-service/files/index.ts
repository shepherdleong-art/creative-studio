import { createHash } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AccessActor } from '../../media-core/access-context.ts';
import { fileResponse } from '../../media-core/file-response.ts';
import { resolveStoragePath } from '../../media-core/storage-path.ts';
import { requireResourceAccess } from '../resource-scopes.ts';
import type { TeamFileRecord } from './registry.ts';

export { registerReadyTeamFile } from './registry.ts';
export type { TeamFileRecord, TeamFileReference } from './registry.ts';

export class TeamFileAccessError extends Error {
  readonly code = 'file_not_found';
  readonly status = 404;

  constructor() {
    super('文件不存在或不可用。');
    this.name = 'TeamFileAccessError';
  }
}

export interface TeamFileSelector {
  storageRoot: string;
  fileId?: string;
  relativePath?: string;
}

export interface ResolvedTeamFile extends TeamFileRecord {
  absolutePath: string;
}

function readSelector(db: Database.Database, selector: TeamFileSelector): TeamFileRecord | undefined {
  if (selector.fileId) {
    return db.prepare("SELECT * FROM team_files WHERE id = ? AND state = 'ready'").get(selector.fileId) as TeamFileRecord | undefined;
  }
  if (selector.relativePath) {
    const absolute = resolveStoragePath(selector.storageRoot, selector.relativePath, { allowAbsolute: true });
    const relativePath = path.relative(path.resolve(selector.storageRoot), absolute).split(path.sep).join('/');
    return db.prepare("SELECT * FROM team_files WHERE relativePath = ? AND state = 'ready'").get(relativePath) as TeamFileRecord | undefined;
  }
  return undefined;
}

export function resolveTeamFile(
  db: Database.Database,
  actor: AccessActor,
  selector: TeamFileSelector,
): ResolvedTeamFile {
  let file: TeamFileRecord | undefined;
  try {
    file = readSelector(db, selector);
  } catch {
    throw new TeamFileAccessError();
  }
  if (!file) throw new TeamFileAccessError();
  const references = db.prepare(`
    SELECT resourceType, resourceId FROM team_file_references
    WHERE fileId = ? AND releasedAt IS NULL
  `).all(file.id) as Array<{ resourceType: string; resourceId: string }>;
  let authorized = false;
  for (const reference of references) {
    try {
      requireResourceAccess(db, actor, reference.resourceType, reference.resourceId, 'read');
      authorized = true;
      break;
    } catch {
      // 任一仍有效的实体引用即可授权；其它引用无权不泄露文件存在性。
    }
  }
  if (!authorized) throw new TeamFileAccessError();
  const absolutePath = resolveStoragePath(selector.storageRoot, file.relativePath);
  return { ...file, absolutePath };
}

export function teamFileEtag(file: Pick<TeamFileRecord, 'id' | 'version' | 'sha256'>): string {
  return `"${createHash('sha256').update(`${file.id}\0${file.version}\0${file.sha256}`).digest('hex')}"`;
}

export function teamFileResponse(
  request: Request,
  db: Database.Database,
  actor: AccessActor,
  selector: TeamFileSelector & { downloadName?: string },
): Response {
  const file = resolveTeamFile(db, actor, selector);
  return fileResponse(request, file.absolutePath, file.mimeType, {
    cacheControl: 'private, no-store',
    etag: teamFileEtag(file),
    downloadName: selector.downloadName,
    grant: { fileId: file.id, seriesId: file.seriesId, version: file.version, sha256: file.sha256 },
  });
}
