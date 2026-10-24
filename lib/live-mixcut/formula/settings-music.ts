import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../../data-root.ts';
import { assertNoStorageSymlink } from '../../media-core/storage-path.ts';
import { readBatchBgmPool, type BatchBgmPoolEntry } from '../bgm.ts';
import { computeFingerprintFromFile, fingerprintsEqual } from '../fingerprint.ts';
import { BatchDomainError } from '../errors.ts';
import type { FormulaSettings } from './settings.ts';

export function selectFormulaMusicPool(db: Database.Database, selection: FormulaSettings['bgm']): BatchBgmPoolEntry[] {
  if (selection.mode === 'none') return [];
  const pool = readBatchBgmPool(db);
  if (selection.mode === 'auto') {
    if (!pool.length) throw new BatchDomainError('invalid_input', '曲库为空，请添加音乐或改为不加音乐');
    return pool;
  }
  if (!selection.trackIds.length) throw new BatchDomainError('invalid_input', '请至少选择一首音乐，或改为不加音乐');
  const selected = new Set(selection.trackIds);
  const entries = pool.filter(entry => selected.has(entry.trackId));
  if (entries.length !== selected.size) throw new BatchDomainError('invalid_input', '已选曲目不存在或不可用，请重新选择或改为不加音乐');
  return entries;
}

/** 保存时核验实际文件；生成输入冻结时仍须重新调用并保存返回的确切候选池。 */
export async function checkFormulaMusicSelection(db: Database.Database, selection: FormulaSettings['bgm'], signal?: AbortSignal): Promise<BatchBgmPoolEntry[]> {
  const pool = selectFormulaMusicPool(db, selection);
  const storageRoot = path.join(dataRoot(), 'storage');
  for (const entry of pool) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(entry.durationUs) || entry.durationUs <= 0) throw new BatchDomainError('invalid_input', '已选音乐时长无效，请重新扫描曲库');
    let filePath: string;
    try {
      if (!entry.relativePath.replaceAll('\\', '/').startsWith('bgm/')) throw new Error();
      filePath = assertNoStorageSymlink(storageRoot, entry.relativePath);
    } catch { throw new BatchDomainError('invalid_input', '已选音乐路径不可用，请重新扫描曲库'); }
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error();
    } catch { throw new BatchDomainError('invalid_input', '已选音乐文件缺失或不可读取，请重新选择或改为不加音乐'); }
    let fingerprint: string;
    try { fingerprint = await computeFingerprintFromFile(filePath); }
    catch { throw new BatchDomainError('invalid_input', '已选音乐文件缺失或不可读取，请重新选择或改为不加音乐'); }
    signal?.throwIfAborted();
    if (!fingerprintsEqual(fingerprint, entry.fileFingerprint)) throw new BatchDomainError('invalid_input', '已选音乐文件内容已变化，请重新扫描曲库后选择');
  }
  return pool;
}
