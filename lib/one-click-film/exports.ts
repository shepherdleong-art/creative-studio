import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { dataRoot } from '../data-root.ts';
import { OneClickFilmError } from './errors.ts';
import type { OneClickFilmRun } from './store.ts';
import { listPackaging, type PackagingRecord } from './packaging.ts';
import { filmStoragePath, readFilmBody } from './composition.ts';
import { registerManagedFile } from '../media-core/access-context.ts';

/**
 * 导出与交付总览（15）。
 *
 * 红线：每次交付绑定当时的脚本、剪辑、音轨与包装版本；重复提交找回同一记录，
 * 再次导出形成独立记录，旧文件摘要不变。全选只包含合格条目。
 */

export interface ExportRecord {
  id: string;
  entryCode: string;
  title: string;
  filename: string;
  url: string;
  checksum: string;
  createdAt: string;
  versions: {
    entryCode: string;
    promptRevision: number;
    packagingRevision: number;
    soundMode: string;
    template: string;
  };
}

interface ExportRow {
  id: string;
  entryCode: string;
  title: string;
  relativePath: string;
  filename: string;
  checksum: string;
  versionJson: string;
  createdAt: string;
}

function toRecord(row: ExportRow): ExportRecord {
  let versions: ExportRecord['versions'] = {
    entryCode: row.entryCode, promptRevision: 0, packagingRevision: 0, soundMode: '', template: '',
  };
  try {
    const parsed = JSON.parse(row.versionJson) as Partial<ExportRecord['versions']>;
    versions = { ...versions, ...parsed };
  } catch { /* 脏版本按空记录展示 */ }
  return {
    id: row.id,
    entryCode: row.entryCode,
    title: row.title,
    filename: row.filename,
    url: `/api/videos/${row.relativePath.split('/').map(encodeURIComponent).join('/')}`,
    checksum: row.checksum,
    createdAt: row.createdAt,
    versions,
  };
}

export function listExports(db: Database.Database, run: OneClickFilmRun): ExportRecord[] {
  return (db.prepare(`SELECT * FROM one_click_film_exports WHERE runId = ? ORDER BY createdAt DESC`)
    .all(run.id) as ExportRow[]).map(toRecord);
}

export interface ExportEligibility {
  entryCode: string;
  eligible: boolean;
  reason: string;
}

/** 全选口径：当前版本已通过、包装修改已保存的合格条目。 */
export function exportEligibility(db: Database.Database, run: OneClickFilmRun): ExportEligibility[] {
  const entries = db.prepare(`SELECT code FROM one_click_film_entries WHERE runId = ? AND retired=0 ORDER BY ordinal`)
    .all(run.id) as Array<{ code: string }>;
  const packaging = new Map(listPackaging(db, run).map((record) => [record.entryCode, record]));
  return entries.map(({ code }) => {
    const record: PackagingRecord | undefined = packaging.get(code);
    if (!record) return { entryCode: code, eligible: false, reason: '还没有包装' };
    if (!record.ready) return { entryCode: code, eligible: false, reason: record.reason || '包装未就绪' };
    return { entryCode: code, eligible: true, reason: '' };
  });
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 导出所选条目。requestKey 由条目 + 包装修订 + 当前文件摘要派生：
 * 重复提交找回同一记录；改了包装或重新包装后导出形成新记录。
 */
export function exportEntries(db: Database.Database, input: {
  run: OneClickFilmRun;
  codes?: string[];
  all?: boolean;
}): { exported: ExportRecord[]; failed: Array<{ entryCode: string; reason: string }>; reused: string[] } {
  const eligibility = exportEligibility(db, input.run);
  const targets = input.all || !input.codes?.length
    ? eligibility.filter((item) => item.eligible)
    : eligibility.filter((item) => input.codes!.includes(item.entryCode));
  const failed = eligibility
    .filter((item) => targets.some((target) => target.entryCode === item.entryCode) && !item.eligible)
    .map((item) => ({ entryCode: item.entryCode, reason: item.reason }));
  if (targets.length === 0) {
    throw new OneClickFilmError('invalid_input', '没有可导出的合格条目');
  }

  const packaging = new Map(listPackaging(db, input.run).map((record) => [record.entryCode, record]));
  const exported: ExportRecord[] = [];
  const reused: string[] = [];
  const exportDir = path.join(dataRoot(), 'storage', 'one-click-film', 'exports', input.run.id);
  fs.mkdirSync(exportDir, { recursive: true });

  for (const target of targets) {
    if (!target.eligible) continue;
    const record = packaging.get(target.entryCode)!;
    const body = readFilmBody(db, input.run, target.entryCode);
    const source = db.prepare('SELECT relativePath FROM one_click_film_packaging WHERE id=? AND revision=? AND status=\'ready\'')
      .pluck().get(record.id, record.revision);
    const absoluteSource = typeof source === 'string' && source ? filmStoragePath(source) : null;
    if (!body || !absoluteSource || !fs.existsSync(absoluteSource)) {
      failed.push({ entryCode: target.entryCode, reason: '成片文件不存在' });
      continue;
    }
    const checksum = sha256File(absoluteSource);
    const requestKey = `${target.entryCode}:${record.revision}:${checksum}`;
    const existing = db.prepare(`SELECT * FROM one_click_film_exports WHERE runId = ? AND requestKey = ?`)
      .get(input.run.id, requestKey) as ExportRow | undefined;
    if (existing) {
      reused.push(target.entryCode);
      exported.push(toRecord(existing));
      continue;
    }

    const id = uuidv4();
    const filename = `${target.entryCode}-${record.title || record.entryCode}-v${record.revision}.mp4`
      .replace(/[\\/:*?"<>|]/g, '_');
    const relativePath = path.posix.join('one-click-film', 'exports', input.run.id, id, filename);
    const destination = path.join(dataRoot(), 'storage', relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    const versionJson = JSON.stringify({
      entryCode: target.entryCode,
      promptRevision: body.snapshot.scriptRevision ?? 0,
      promptText: body.snapshot.promptText,
      editSignature: body.signature,
      narrationPath: body.snapshot.narrationPath,
      packagingRevision: record.revision,
      soundMode: body.snapshot.soundMode ?? 'native',
      template: record.template,
    });
    const createdAt = new Date().toISOString();
    try {
      fs.copyFileSync(absoluteSource, destination, fs.constants.COPYFILE_EXCL);
      db.transaction(() => {
        db.prepare(`
      INSERT INTO one_click_film_exports
        (id, runId, projectId, entryId, entryCode, requestKey, title, relativePath, filename, checksum,
         versionJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, input.run.id, input.run.projectId, body.entryId, target.entryCode, requestKey,
          record.title, relativePath, filename, checksum, versionJson, createdAt);
        registerManagedFile({ absolutePath: destination, mimeType: 'video/mp4',
          references: [{ resourceType: 'project', resourceId: input.run.projectId, role: 'delivery', pinKind: 'export' }] });
      }).immediate();
    } catch (error) {
      fs.rmSync(destination, { force: true });
      failed.push({ entryCode: target.entryCode, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    exported.push(toRecord({
      id, entryCode: target.entryCode, title: record.title, relativePath, filename,
      checksum, versionJson, createdAt,
    }));
  }

  return { exported, failed, reused };
}

/** 下载 ZIP 的条目清单：只用已登记交付记录，绝不按目录扫描。 */
export function exportZipEntries(db: Database.Database, input: {
  run: OneClickFilmRun;
  ids: string[];
}): Array<{ filePath: string; filename: string }> {
  if (input.ids.length === 0) throw new OneClickFilmError('invalid_input', '请先选择要下载的交付记录');
  const placeholders = input.ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT filename, relativePath FROM one_click_film_exports
    WHERE runId = ? AND id IN (${placeholders})`).all(input.run.id, ...input.ids) as Array<{
      filename: string; relativePath: string;
    }>;
  if (rows.length !== new Set(input.ids).size) throw new OneClickFilmError('not_found', '找不到可下载的交付记录', 404);
  return rows.map((row) => ({
    filePath: filmStoragePath(row.relativePath),
    filename: row.filename,
  }));
}
