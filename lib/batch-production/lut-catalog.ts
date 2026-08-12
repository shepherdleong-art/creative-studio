import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { runFfmpeg } from '../ffmpeg.ts';
import { assertNoStorageSymlink, resolveStoragePath } from '../media-core/storage-path.ts';
import {
  buildLutVerificationArgs,
  COLOR_SNAPSHOT_OFF,
  makeColorSnapshot,
  type ColorSnapshotV1,
} from './color-pipeline.ts';
import { BatchDomainError } from './errors.ts';
import { computeFingerprintFromBuffer, fingerprintsEqual, normalizeFingerprint } from './fingerprint.ts';

export type BatchLutStatus = 'active' | 'archived';

export interface BatchLutRow {
  id: string;
  projectId: string;
  contentFingerprint: string;
  displayName: string;
  relativePath: string;
  fileSizeBytes: number;
  verifiedAt: string | null;
  status: BatchLutStatus;
  createdAt: string;
  updatedAt: string;
}

/** 兼容旧格式:只有 lutId 的输入快照。 */
export type ColorSnapshotInput = ColorSnapshotV1 | { lutId: string | null };

/**
 * 服务端按项目内受管 LUT 构建完整 ColorSnapshotV1(客户端只允许提交 lutId)。
 *
 * - lutId 为 null/空 → 完整关闭快照。
 * - lutId 非空 → 必须能解析出项目内受管 LUT(存在、属于该项目、active),
 *   指纹一律以 batch_luts.contentFingerprint 为准;调用方如果提供了指纹,
 *   必须与受管内容一致,否则拒绝。lutFingerprint 永远不可能为空字符串——
 *   空字符串绕过在这里被彻底禁止。
 * - 'unresolved:' 标记视为无效输入,直接拒绝(不允许把迁移期脏数据当新输入)。
 */
export function resolveColorSnapshot(
  db: Database.Database,
  projectId: string,
  input: ColorSnapshotInput | undefined | null,
): ColorSnapshotV1 {
  const raw = input ?? { lutId: null };
  const lutId = raw.lutId ?? null;
  if (!lutId) {
    return COLOR_SNAPSHOT_OFF;
  }
  const providedFingerprint = 'lutFingerprint' in raw && typeof raw.lutFingerprint === 'string'
    ? raw.lutFingerprint
    : null;
  if (providedFingerprint && providedFingerprint.startsWith('unresolved:')) {
    throw new BatchDomainError('invalid_input', '色彩快照携带了无法解析的 LUT 指纹标记');
  }
  const lut = db.prepare(`
    SELECT id, projectId, status, contentFingerprint FROM batch_luts WHERE id = ?
  `).get(lutId) as { id: string; projectId: string; status: BatchLutStatus; contentFingerprint: string } | undefined;
  if (!lut) {
    throw new BatchDomainError('not_found', 'LUT 不存在');
  }
  if (lut.projectId !== projectId) {
    throw new BatchDomainError('invalid_input', 'LUT 不属于该批次所在项目');
  }
  if (lut.status !== 'active') {
    throw new BatchDomainError('conflict', '归档的 LUT 不能进入新的批次选择');
  }
  if (providedFingerprint && !fingerprintsEqual(providedFingerprint, lut.contentFingerprint)) {
    throw new BatchDomainError('invalid_input', '色彩快照中的 LUT 指纹与受管内容不一致');
  }
  return makeColorSnapshot(lut.id, normalizeFingerprint(lut.contentFingerprint));
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/**
 * 登记一份已经核验并复制到受管目录的 LUT 内容(纯领域接口,不做文件 IO/FFmpeg 验证——
 * 那些属于 D3 LutCatalog Module 的导入 Adapter)。
 * 同项目同完整内容指纹只保留一份身份,重复导入复用同一 id;
 * 同名不同内容永远建立新身份,不覆盖旧内容,已冻结批次版本的引用不受影响。
 */
export function createManagedLut(
  db: Database.Database,
  projectId: string,
  input: {
    contentFingerprint: string;
    displayName: string;
    relativePath: string;
    fileSizeBytes: number;
    verifiedAt?: string;
    now?: () => Date;
  },
): string {
  const fingerprint = normalizeFingerprint(input.contentFingerprint);
  const createdAt = nowIso(input.now);
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM batch_luts WHERE projectId = ? AND contentFingerprint = ?
    `).get(projectId, fingerprint) as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_luts
        (id, projectId, contentFingerprint, displayName, relativePath, fileSizeBytes, verifiedAt, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      id,
      projectId,
      fingerprint,
      input.displayName,
      input.relativePath,
      input.fileSizeBytes,
      input.verifiedAt ?? createdAt,
      createdAt,
      createdAt,
    );
    return id;
  })();
}

export function getLut(db: Database.Database, projectId: string, lutId: string): BatchLutRow | undefined {
  return db.prepare(`
    SELECT * FROM batch_luts WHERE id = ? AND projectId = ?
  `).get(lutId, projectId) as BatchLutRow | undefined;
}

/** 项目可选 LUT 列表;默认只列出 active,供批次选择器使用。 */
export function listProjectLuts(
  db: Database.Database,
  projectId: string,
  options: { includeArchived?: boolean } = {},
): BatchLutRow[] {
  if (options.includeArchived) {
    return db.prepare(`
      SELECT * FROM batch_luts WHERE projectId = ? ORDER BY createdAt, id
    `).all(projectId) as BatchLutRow[];
  }
  return db.prepare(`
    SELECT * FROM batch_luts WHERE projectId = ? AND status = 'active' ORDER BY createdAt, id
  `).all(projectId) as BatchLutRow[];
}

/** LUT 是否仍被任何草稿或已冻结的批次版本引用(素材池色彩快照)。 */
function isLutReferenced(db: Database.Database, lutId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM batch_asset_pool_items
    WHERE json_extract(colorJson, '$.lutId') = ?
    LIMIT 1
  `).get(lutId);
  return Boolean(row);
}

/**
 * 归档 LUT:从新选择列表隐藏,但文件与历史引用关系继续保留,可以恢复。
 * 归档本身不检查引用——它总是允许的,是安全的"软删除"。
 */
export function archiveLut(db: Database.Database, projectId: string, lutId: string, now?: () => Date): void {
  const result = db.prepare(`
    UPDATE batch_luts SET status = 'archived', updatedAt = ? WHERE id = ? AND projectId = ?
  `).run(nowIso(now), lutId, projectId);
  if (result.changes === 0) {
    throw new BatchDomainError('not_found', 'LUT 不存在');
  }
}

/** 恢复一份已归档 LUT,重新出现在新批次选择列表中。 */
export function restoreLut(db: Database.Database, projectId: string, lutId: string, now?: () => Date): void {
  const result = db.prepare(`
    UPDATE batch_luts SET status = 'active', updatedAt = ? WHERE id = ? AND projectId = ?
  `).run(nowIso(now), lutId, projectId);
  if (result.changes === 0) {
    throw new BatchDomainError('not_found', 'LUT 不存在');
  }
}

/**
 * 只有没有任何草稿、批次版本、成片版本或历史任务引用时,才允许物理清理受管 LUT 文件。
 * 仍被引用时只能归档;调用方应该先 archiveLut,再定期用这个函数找出真正可以清理的记录。
 * 数据库行删除和受管文件删除在同一次调用内一起完成,不留下孤儿文件或悬空记录。
 */
export function deleteLutIfUnreferenced(db: Database.Database, projectId: string, lutId: string): boolean {
  const relativePath = db.transaction(() => {
    const lut = db.prepare(`
      SELECT relativePath FROM batch_luts WHERE id = ? AND projectId = ?
    `).get(lutId, projectId) as { relativePath: string } | undefined;
    if (!lut) {
      throw new BatchDomainError('not_found', 'LUT 不存在');
    }
    if (isLutReferenced(db, lutId)) {
      return null;
    }
    db.prepare(`DELETE FROM batch_luts WHERE id = ?`).run(lutId);
    return lut.relativePath;
  })();
  if (relativePath === null) {
    return false;
  }
  try {
    const absolutePath = resolveManagedLutPath(relativePath);
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  } catch {
    // 数据库行已经是权威身份来源,文件删除失败(例如已经被手动清理)不影响
    // "这个 LUT 身份已经清理"的结果——不会有代码再通过旧 id 读到它。
  }
  return true;
}

/** 把受管相对路径解析成文件系统绝对路径,拒绝越界、绝对路径输入和符号链接。 */
export function resolveManagedLutPath(relativePath: string): string {
  const root = dataRoot();
  const resolved = resolveStoragePath(root, relativePath);
  assertNoStorageSymlink(root, relativePath);
  return resolved;
}

export class LutImportError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'LutImportError';
    this.code = code;
    this.status = status;
  }
}

export interface LutUpload {
  filename: string;
  mimeType: string;
  data: Buffer;
}

// 常见 17/33/65 点位 .cube 文本文件通常只有几百 KB;8MB 是留了充足余量的上限,
// 不是产品承诺的精确阈值。
const MAX_LUT_FILE_BYTES = 8 * 1024 * 1024;

function validateLutUpload(upload: LutUpload): { originalFilename: string } {
  const normalizedName = upload.filename.replace(/\\/g, '/');
  const extension = path.extname(normalizedName).toLowerCase();
  if (extension !== '.cube') {
    throw new LutImportError('unsupported_lut_format', 'V1 只支持 .cube LUT 文件');
  }
  if (upload.data.length === 0) {
    throw new LutImportError('empty_upload', '上传文件为空');
  }
  if (upload.data.length > MAX_LUT_FILE_BYTES) {
    throw new LutImportError('lut_too_large', 'LUT 文件超出大小限制');
  }
  const base = path.posix.basename(normalizedName).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return { originalFilename: base || `upload${extension}` };
}

/** 用本地真实 FFmpeg 对一帧极小合成画面做 lut3d 验证,拒绝损坏或不支持的 .cube 内容。 */
async function verifyLutWithFfmpeg(lutAbsolutePath: string): Promise<void> {
  const probeOutput = `${lutAbsolutePath}.verify-${randomUUID()}.jpg`;
  try {
    await runFfmpeg([
      ...buildLutVerificationArgs(lutAbsolutePath),
      probeOutput,
    ], { timeoutMs: 10_000 });
  } catch {
    throw new LutImportError('invalid_lut_content', 'LUT 文件验证失败,可能已损坏或格式不受支持');
  } finally {
    try { fs.unlinkSync(probeOutput); } catch { /* 验证失败时可能从未生成,忽略 */ }
  }
}

/**
 * LutCatalog 的导入入口:校验普通文件/扩展名/大小上限 -> 完整 SHA-256 去重 ->
 * 临时文件落盘 -> 真实 FFmpeg lut3d 验证通过后原子改名进受管目录 -> 登记身份。
 * 同一内容重复导入复用身份(reused: true);同名不同内容永远建立新身份。
 * 只接受已经读入内存的文件内容,不接受也不解析任何调用方提交的本机路径字符串——
 * 桌面原生文件选择器是后续 Phase G 的另一个 Adapter,这里先只支持浏览器上传。
 */
export async function importLut(
  db: Database.Database,
  projectId: string,
  upload: LutUpload,
  now?: () => Date,
): Promise<{ id: string; reused: boolean }> {
  const { originalFilename } = validateLutUpload(upload);
  const fingerprint = computeFingerprintFromBuffer(upload.data);

  const existing = db.prepare(`
    SELECT id FROM batch_luts WHERE projectId = ? AND contentFingerprint = ?
  `).get(projectId, fingerprint) as { id: string } | undefined;
  if (existing) {
    return { id: existing.id, reused: true };
  }

  const fingerprintHex = fingerprint.slice('sha256:'.length);
  const relativePath = path.join('storage', 'luts', projectId, `${fingerprintHex}.cube`);
  const absolutePath = resolveManagedLutPath(relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  // 临时文件名必须保留 .cube 扩展名——FFmpeg 的 lut3d filter 按扩展名识别 LUT 格式,
  // 把随机后缀直接拼在 .cube 之后会让 ffmpeg 把 ".tmp-<uuid>" 当成(无法识别的)扩展名。
  const tempPath = `${absolutePath.slice(0, -'.cube'.length)}.tmp-${randomUUID()}.cube`;
  fs.writeFileSync(tempPath, upload.data);
  try {
    await verifyLutWithFfmpeg(tempPath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw error;
  }
  if (fs.existsSync(absolutePath)) {
    // 同一指纹的极小概率并发导入:目标已经被另一次调用原子落位,丢弃临时文件即可。
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  } else {
    fs.renameSync(tempPath, absolutePath);
  }

  const id = createManagedLut(db, projectId, {
    contentFingerprint: fingerprint,
    displayName: originalFilename,
    relativePath,
    fileSizeBytes: upload.data.length,
    verifiedAt: nowIso(now),
    now,
  });
  return { id, reused: false };
}
