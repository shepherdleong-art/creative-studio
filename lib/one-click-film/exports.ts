import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { dataRoot } from '../data-root.ts';
import { OneClickFilmError } from './errors.ts';
import type { OneClickFilmRun } from './store.ts';
import { listPackaging, type PackagingRecord } from './packaging.ts';

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
  const entries = db.prepare(`SELECT code FROM one_click_film_entries WHERE runId = ? ORDER BY ordinal`)
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

/** 数据库里的媒体路径可能是绝对路径，也可能已经带 storage 前缀。 */
function absoluteStoragePath(value: string): string {
  const storageRoot = path.join(dataRoot(), 'storage');
  const normalized = value.replace(/\\/g, '/');
  const marker = '/storage/';
  const index = normalized.lastIndexOf(marker);
  // 数据库里常见三种形态：绝对路径、带 storage 前缀的相对路径、纯相对路径。
  // 前两种先剥离到 storage 之后，避免把 storage 拼两次。
  if (normalized.startsWith('storage/')) return path.join(dataRoot(), normalized);
  if (index >= 0) return path.join(storageRoot, normalized.slice(index + marker.length));
  if (path.isAbsolute(value)) return value;
  return path.join(storageRoot, value);
}

function publishedPath(db: Database.Database, run: OneClickFilmRun, entryCode: string): string {
  // 交付读取当前采用的成片文件：优先高清结果，其次原片。
  const hd = db.prepare(`SELECT localVideoPath FROM one_click_film_hd_sources
    WHERE runId = ? AND entryCode = ? AND status = 'ready' ORDER BY createdAt DESC LIMIT 1`)
    .get(run.id, entryCode) as { localVideoPath: string } | undefined;
  if (hd?.localVideoPath) return hd.localVideoPath;
  const original = db.prepare(`
    SELECT vj.localVideoPath FROM one_click_film_video_jobs v
    JOIN video_jobs vj ON vj.id = v.videoJobId
    WHERE v.runId = ? AND v.entryCode = ? AND vj.status = 'succeeded'
    ORDER BY v.createdAt DESC LIMIT 1
  `).get(run.id, entryCode) as { localVideoPath: string } | undefined;
  if (!original?.localVideoPath) {
    throw new OneClickFilmError('invalid_input', `${entryCode} 还没有可交付的成片文件`);
  }
  return original.localVideoPath;
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
    const record = packaging.get(target.entryCode)!;
    const source = publishedPath(db, input.run, target.entryCode);
    const absoluteSource = absoluteStoragePath(source);
    if (!fs.existsSync(absoluteSource)) {
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

    const entry = db.prepare(`SELECT id, scriptRevision, soundMode FROM one_click_film_entries
      WHERE runId = ? AND code = ?`).get(input.run.id, target.entryCode) as {
        id: string; scriptRevision: number; soundMode: string;
      };
    const filename = `${target.entryCode}-${record.title || record.entryCode}-v${record.revision}.mp4`
      .replace(/[\\/:*?"<>|]/g, '_');
    const relativePath = path.posix.join('one-click-film', 'exports', input.run.id, filename);
    const destination = path.join(dataRoot(), 'storage', relativePath);
    fs.copyFileSync(absoluteSource, destination);

    const id = uuidv4();
    const versionJson = JSON.stringify({
      entryCode: target.entryCode,
      promptRevision: entry.scriptRevision,
      packagingRevision: record.revision,
      soundMode: entry.soundMode,
      template: record.template,
    });
    db.prepare(`
      INSERT INTO one_click_film_exports
        (id, runId, projectId, entryId, entryCode, requestKey, title, relativePath, filename, checksum,
         versionJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.run.id, input.run.projectId, entry.id, target.entryCode, requestKey,
      record.title, relativePath, filename, checksum, versionJson, new Date().toISOString(),
    );
    exported.push(toRecord({
      id, entryCode: target.entryCode, title: record.title, relativePath, filename,
      checksum, versionJson, createdAt: new Date().toISOString(),
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
  if (rows.length === 0) throw new OneClickFilmError('not_found', '找不到可下载的交付记录', 404);
  return rows.map((row) => ({
    filePath: path.join(dataRoot(), 'storage', row.relativePath),
    filename: row.filename,
  }));
}
