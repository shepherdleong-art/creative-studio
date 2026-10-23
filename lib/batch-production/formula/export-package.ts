import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataRoot } from '../../data-root.ts';
import { assertNoStorageSymlink } from '../../media-core/storage-path.ts';
import { fingerprintHex } from '../fingerprint.ts';
import { verifyZipFile } from '../../media-core/verified-zip.ts';
import { BatchDomainError } from '../errors.ts';
import { getBatchWorkspace } from '../batch-workspace.ts';
import { assertFormulaBatch } from './collection-store.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import { captureFormulaManifestItem } from './export-manifest.ts';
import type { FormulaGenerationRequest } from './generation.ts';

export interface FormulaPackageSelection { planId: string; videoArtifactId: string; coverArtifactId: string }
export interface FormulaPackageFile { artifactId: string; filename: string; checksum: string }
export interface FormulaExportManifest {
  format: 'formula-export/1'; packageId: string; batchId: string; batchName: string; createdAt: string;
  items: Array<ReturnType<typeof captureFormulaManifestItem> & { video: FormulaPackageFile; coverFile: FormulaPackageFile }>;
}
export interface FormulaExportPackage { id: string; createdAt: string; manifest: FormulaExportManifest }
export interface FormulaPackageSummary { id: string; createdAt: string; count: number }
export class FormulaPackageError extends BatchDomainError {
  readonly items: Array<{ planId: string; message: string }>;
  constructor(items: Array<{ planId: string; message: string }>) {
    super('conflict', '所选成片未能全部打包，请处理下列问题后重试'); this.items = items;
  }
}
interface PackageRow { id: string; createdAt: string; manifestJson: string; selectionJson: string }
interface FileSnapshot { planId: string; relativePath: string; checksum: string; stat: string }
const decode = (row: PackageRow): FormulaExportPackage => ({ id: row.id, createdAt: row.createdAt, manifest: JSON.parse(row.manifestJson) });

function selectionInput(input: { requestKey: string; items: FormulaPackageSelection[] }) {
  if (!input || typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 200
    || !Array.isArray(input.items) || !input.items.length || input.items.length > 1000
    || input.items.some(item => !item || [item.planId, item.videoArtifactId, item.coverArtifactId]
      .some(value => typeof value !== 'string' || !value.trim() || value.length > 200))
    || new Set(input.items.map(item => item.planId)).size !== input.items.length) {
    throw new BatchDomainError('invalid_input', '请选择 1–1000 条不重复的正式成片，并保留其视频和封面身份');
  }
  return input.items.map(({ planId, videoArtifactId, coverArtifactId }) => ({ planId, videoArtifactId, coverArtifactId }));
}

function fileState(relativePath: string) {
  const absolutePath = assertNoStorageSymlink(path.join(dataRoot(), 'storage'), relativePath);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('正式文件不存在');
  return { absolutePath, stat: JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]) };
}

function capture(db: Database.Database, projectId: string, batchId: string, selection: FormulaPackageSelection[]) {
  const workspace = getBatchWorkspace(db, projectId, batchId);
  const cards = new Map(workspace.cards.map(card => [card.planId, card]));
  const requests = new Map<string, FormulaGenerationRequest>();
  const errors: FormulaPackageError['items'] = [];
  const files: FileSnapshot[] = [];
  const items: FormulaExportManifest['items'] = [];
  for (const [index, selected] of selection.entries()) {
    try {
      const card = cards.get(selected.planId), formal = card?.currentFormalArtifact;
      if (!card || !card.approved || !card.exportEligible || card.formalOutdated || card.exportStatus !== 'exported'
        || !formal?.cover || formal.video.id !== selected.videoArtifactId || formal.cover.id !== selected.coverArtifactId) {
        throw new BatchDomainError('conflict', '正式视频、封面或审核已变化，请刷新并重新选择当前已确认、已导出的成片');
      }
      const content = captureFormulaManifestItem(db, projectId, batchId, selected.planId, requests);
      const publicFiles = [formal.video, formal.cover].map(artifact => {
        files.push({ planId: card.planId, relativePath: artifact.relativePath, checksum: artifact.checksum, stat: fileState(artifact.relativePath).stat });
        // Unique numbered directories preserve Chinese filenames, even when two publications have identical basenames.
        const basename = artifact.relativePath.replaceAll('\\', '/').split('/').at(-1)!;
        if (!basename || /[<>:"|?*\x00-\x1f]/.test(basename)) throw new Error('正式文件名无效');
        return { artifactId: artifact.id, filename: `成片/${String(index + 1).padStart(4, '0')}/${basename}`, checksum: artifact.checksum };
      });
      items.push({ ...content, video: publicFiles[0], coverFile: publicFiles[1] });
    } catch (error) {
      errors.push({ planId: selected.planId, message: error instanceof BatchDomainError ? error.message : '正式文件或清单依据缺失、不可读，请重新导出' });
    }
  }
  if (errors.length) throw new FormulaPackageError(errors);
  return { batchName: workspace.batch.name, items, files };
}

/** Freeze only the exact current, reviewed artifact pair shown to the caller. Retrying the same request returns its original package. */
export async function createFormulaExportPackage(db: Database.Database, projectId: string, batchId: string,
  input: { requestKey: string; items: FormulaPackageSelection[]; signal?: AbortSignal }): Promise<FormulaExportPackage> {
  const selection = selectionInput(input), selectionJson = JSON.stringify(selection);
  assertFormulaBatch(db, projectId, batchId);
  const existing = () => {
    const row = db.prepare('SELECT * FROM batch_formula_export_packages WHERE projectId=? AND batchId=? AND requestKey=?')
      .get(projectId, batchId, input.requestKey) as PackageRow | undefined;
    if (row && row.selectionJson !== selectionJson) throw new BatchDomainError('conflict', '这次打包请求已用于另一份选择，请重新发起');
    return row ? decode(row) : undefined;
  };
  const prior = existing(); if (prior) return prior;
  if (!formulaExecutionAvailable(db)) throw new BatchDomainError('conflict', '实拍公式功能当前不可用，已有导出包仍可下载');
  const captured = db.transaction(() => capture(db, projectId, batchId, selection))();
  const errors: FormulaPackageError['items'] = [];
  for (const file of captured.files) {
    input.signal?.throwIfAborted();
    try {
      const state = fileState(file.relativePath);
      if (state.stat !== file.stat) throw new Error('changed');
      await verifyZipFile(path.join(dataRoot(), 'storage'), { relativePath: file.relativePath, filename: '', sha256: fingerprintHex(file.checksum) }, input.signal);
      if (fileState(file.relativePath).stat !== file.stat) throw new Error('changed');
    } catch {
      input.signal?.throwIfAborted();
      errors.push({ planId: file.planId, message: '正式视频或封面的内容已变化或不可读，请重新导出' });
    }
  }
  if (errors.length) throw new FormulaPackageError(errors);
  return db.transaction(() => {
    input.signal?.throwIfAborted();
    const prior = existing(); if (prior) return prior;
    if (!formulaExecutionAvailable(db)) throw new BatchDomainError('conflict', '实拍公式功能已停用，请重试');
    const current = capture(db, projectId, batchId, selection);
    if (JSON.stringify(current) !== JSON.stringify(captured)) throw new BatchDomainError('conflict', '打包期间成片或文件已变化，请刷新后重试');
    const id = randomUUID(), createdAt = new Date().toISOString();
    const manifest: FormulaExportManifest = { format: 'formula-export/1', packageId: id, batchId, batchName: captured.batchName, createdAt, items: captured.items };
    db.prepare('INSERT INTO batch_formula_export_packages (id,projectId,batchId,requestKey,selectionJson,manifestJson,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(id, projectId, batchId, input.requestKey, selectionJson, JSON.stringify(manifest), createdAt);
    const add = db.prepare('INSERT INTO batch_formula_export_package_items VALUES (?,?,?,?)');
    for (const item of selection) add.run(id, item.planId, item.videoArtifactId, item.coverArtifactId);
    return getFormulaExportPackage(db, projectId, batchId, id);
  }).immediate();
}

/** Historical reads do not depend on the execution feature flag or today's arrangement/review. */
export function getFormulaExportPackage(db: Database.Database, projectId: string, batchId: string, packageId: string): FormulaExportPackage {
  const row = db.prepare('SELECT * FROM batch_formula_export_packages WHERE id=? AND projectId=? AND batchId=?')
    .get(packageId, projectId, batchId) as PackageRow | undefined;
  if (!row) throw new BatchDomainError('not_found', '导出包不存在');
  return decode(row);
}

export function listFormulaExportPackages(db: Database.Database, projectId: string, batchId: string): FormulaPackageSummary[] {
  assertFormulaBatch(db, projectId, batchId);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_formula_export_packages'").get()) return [];
  return db.prepare(`SELECT id,createdAt,json_array_length(manifestJson,'$.items') AS count
    FROM batch_formula_export_packages WHERE projectId=? AND batchId=? ORDER BY createdAt DESC,id DESC`)
    .all(projectId, batchId) as FormulaPackageSummary[];
}
