import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { assertNoStorageSymlink } from '../../media-core/storage-path.ts';
import { assertTeamPublicationAllowed } from '../lifecycle/barrier.ts';

export type TeamFileState = 'staged' | 'ready' | 'purge_pending';
export type TeamFileRole = 'input' | 'output' | 'derivative' | 'export' | 'delivery' | 'backup';
export type TeamFilePinKind = 'entity' | 'accepted_task' | 'export' | 'backup';

export interface TeamFileReference {
  resourceType: string;
  resourceId: string;
  role?: TeamFileRole;
  pinKind?: TeamFilePinKind;
}

export interface TeamFileRecord {
  id: string;
  seriesId: string;
  version: number;
  ownerUserId: string;
  relativePath: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  state: TeamFileState;
  derivedFromFileId: string | null;
  /** 上次完整内容核验时的文件身份；仅衍生文件记录，用于跳过重复全量哈希。 */
  verifiedIdentityJson: string | null;
  readySeq: number | null;
  createdAt: string;
  readyAt: string | null;
}

export interface RegisterReadyTeamFileInput {
  storageRoot: string;
  absolutePath: string;
  mimeType: string;
  ownerUserId: string;
  references?: TeamFileReference[];
  derivedFromFileId?: string;
  seriesId?: string;
  now?: () => Date;
  validateReference?: (reference: TeamFileReference) => void;
  validateExisting?: (file: TeamFileRecord) => void;
}

function sha256FileSync(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.byteLength, null);
      if (bytes <= 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

interface TeamFileStatIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * 衍生文件身份：dev/ino/size/mtime/ctime。
 * 只在身份完全一致时才信任上次的完整内容核验；路径相同不足以证明内容未变。
 */
function teamFileIdentityJson(stat: fs.Stats): string {
  return JSON.stringify({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  } satisfies TeamFileStatIdentity);
}

function parseTeamFileIdentity(value: string | null): TeamFileStatIdentity | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.dev !== 'number' || typeof record.ino !== 'number'
      || typeof record.size !== 'number' || typeof record.mtimeMs !== 'number'
      || typeof record.ctimeMs !== 'number'
    ) return null;
    return {
      dev: record.dev,
      ino: record.ino,
      size: record.size,
      mtimeMs: record.mtimeMs,
      ctimeMs: record.ctimeMs,
    };
  } catch {
    return null;
  }
}

function statMatchesTeamFileIdentity(stat: fs.Stats, identityJson: string | null): boolean {
  const expected = parseTeamFileIdentity(identityJson);
  if (!expected) return false;
  return stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.size === expected.size
    && stat.mtimeMs === expected.mtimeMs
    && stat.ctimeMs === expected.ctimeMs;
}

function readFile(db: Database.Database, fileId: string): TeamFileRecord | undefined {
  return db.prepare('SELECT * FROM team_files WHERE id = ?').get(fileId) as TeamFileRecord | undefined;
}

function sourceReferences(db: Database.Database, fileId: string): TeamFileReference[] {
  // 备份 pin 只保护备份清单中的原件，不是派生文件的业务归属或读取权限。
  // 继承它既会让员工被管理员私有 scope 拦住，也会伪造新文件已在旧备份中。
  return db.prepare(`
    SELECT resourceType, resourceId, role, pinKind
    FROM team_file_references WHERE fileId = ? AND releasedAt IS NULL AND pinKind <> 'backup'
  `).all(fileId) as TeamFileReference[];
}

export function registerReadyTeamFile(
  db: Database.Database,
  input: RegisterReadyTeamFileInput,
): TeamFileRecord {
  if (!input.ownerUserId.trim() || !input.mimeType.trim()) throw new Error('文件登记字段不完整');
  assertTeamPublicationAllowed(db);
  const absolutePath = assertNoStorageSymlink(input.storageRoot, input.absolutePath, { allowAbsolute: true });
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error('只能登记普通文件');
  const relativePath = path.relative(path.resolve(input.storageRoot), absolutePath).split(path.sep).join('/');
  const source = input.derivedFromFileId ? readFile(db, input.derivedFromFileId) : undefined;
  if (input.derivedFromFileId && (!source || source.state !== 'ready')) {
    throw new Error('衍生物源文件尚未就绪');
  }
  const references = input.derivedFromFileId
    ? sourceReferences(db, input.derivedFromFileId!).map((reference) => ({ ...reference, role: 'derivative' as const }))
    : input.references ?? [];
  if (references.length === 0) throw new Error('文件必须绑定已授权实体');
  for (const reference of references) input.validateReference?.(reference);

  const existing = db.prepare("SELECT * FROM team_files WHERE relativePath = ? AND state = 'ready'")
    .get(relativePath) as TeamFileRecord | undefined;
  if (existing) {
    // 授权与谱系校验必须在任何缓存复用之前完成：命中登记也要逐次授权。
    input.validateExisting?.(existing);
    if (existing.derivedFromFileId !== (input.derivedFromFileId ?? null)) {
      throw new Error('文件身份与既有不可变登记不一致');
    }
    // 快速路径只适用于衍生文件：身份（dev/ino/size/mtime/ctime）完全一致时，
    // 才信任上次完整核验的 sha256。通用文件仍每次读满全文件。
    // 本函数整体同步执行，Node 单线程下不会与其他登记交错，无需额外并发去重。
    const identity = teamFileIdentityJson(stat);
    const reuseVerifiedFingerprint = Boolean(
      input.derivedFromFileId
      && statMatchesTeamFileIdentity(stat, existing.verifiedIdentityJson)
      && existing.byteSize === stat.size,
    );
    const sha256 = reuseVerifiedFingerprint ? existing.sha256 : sha256FileSync(absolutePath);
    if (existing.sha256 !== sha256) {
      throw new Error('文件身份与既有不可变登记不一致');
    }
    const attach = db.prepare(`
      INSERT OR IGNORE INTO team_file_references (fileId, resourceType, resourceId, role, pinKind, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const at = (input.now?.() ?? new Date()).toISOString();
    db.transaction(() => {
      assertTeamPublicationAllowed(db);
      if (input.derivedFromFileId && !reuseVerifiedFingerprint) {
        // 首次登记遗留的旧行缺少身份，或文件身份变化但内容哈希相同：刷新身份记录。
        db.prepare('UPDATE team_files SET verifiedIdentityJson = ? WHERE id = ?').run(identity, existing.id);
      }
      for (const reference of references) {
        attach.run(existing.id, reference.resourceType, reference.resourceId,
          reference.role ?? (input.derivedFromFileId ? 'derivative' : 'input'), reference.pinKind ?? 'entity', at);
      }
    }).immediate();
    return input.derivedFromFileId && !reuseVerifiedFingerprint
      ? { ...existing, verifiedIdentityJson: identity }
      : existing;
  }

  const sha256 = sha256FileSync(absolutePath);
  const id = randomUUID();
  const seriesId = input.seriesId ?? source?.seriesId ?? id;
  const at = (input.now?.() ?? new Date()).toISOString();
  // 身份记录只对衍生文件有意义；通用文件不参与快速路径。
  const verifiedIdentityJson = input.derivedFromFileId ? teamFileIdentityJson(stat) : null;
  const publish = db.transaction(() => {
    assertTeamPublicationAllowed(db);
    const version = ((db.prepare('SELECT MAX(version) AS version FROM team_files WHERE seriesId = ?')
      .get(seriesId) as { version: number | null }).version ?? 0) + 1;
    const readySeq = ((db.prepare('SELECT MAX(readySeq) AS readySeq FROM team_files')
      .get() as { readySeq: number | null }).readySeq ?? 0) + 1;
    db.prepare(`
      INSERT INTO team_files (
        id, seriesId, version, ownerUserId, relativePath, mimeType, byteSize, sha256,
        state, derivedFromFileId, readySeq, createdAt, readyAt, verifiedIdentityJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)
    `).run(
      id, seriesId, version, input.ownerUserId, relativePath, input.mimeType, stat.size, sha256,
      input.derivedFromFileId ?? null, readySeq, at, at, verifiedIdentityJson,
    );
    const insertReference = db.prepare(`
      INSERT INTO team_file_references (fileId, resourceType, resourceId, role, pinKind, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const reference of references) {
      insertReference.run(
        id, reference.resourceType, reference.resourceId,
        reference.role ?? (input.derivedFromFileId ? 'derivative' : 'input'),
        reference.pinKind ?? 'entity', at,
      );
    }
  });
  publish.immediate();
  return readFile(db, id)!;
}
