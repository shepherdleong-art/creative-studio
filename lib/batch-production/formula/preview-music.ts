import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../../data-root.ts';
import { assertNoStorageSymlink } from '../../media-core/storage-path.ts';
import { BatchDomainError } from '../errors.ts';
import { computeFingerprintFromFile, fingerprintsEqual } from '../fingerprint.ts';
import { assertProjectAssetFileIdentity, projectAssetFileIdentity } from '../project-asset-media.ts';
import { readFormulaMusicSource } from './output-music.ts';

export interface FormulaMusicPreviewIdentity { outputVersionId: string; sourceFingerprint: string }

/** Only a saved source belonging to this current output may be streamed. */
export async function resolveFormulaPreviewMusic(db: Database.Database, projectId: string, batchId: string, planId: string,
  selectionStageId: string, timelineStageId: string, trackId: string, expected: FormulaMusicPreviewIdentity | undefined, signal: AbortSignal) {
  if (!expected?.outputVersionId || !expected.sourceFingerprint) throw new BatchDomainError('invalid_input', '缺少音乐版本，请刷新成片');
  const read = () => {
    signal.throwIfAborted();
    const row = db.prepare(`SELECT o.arrangementJson FROM batch_formula_output_versions f
      JOIN batch_output_versions o ON o.id=f.outputVersionId JOIN batch_output_plans p ON p.id=o.planId
      JOIN batch_formula_execution_stages e ON e.id=f.timelineStageId
      JOIN batch_formula_generation_requests g ON g.id=e.requestId JOIN batch_productions b ON b.id=g.batchId
      WHERE o.id=? AND p.id=? AND p.currentVersionId=o.id AND f.timelineStageId=? AND e.selectionStageId=?
        AND e.planId=p.id AND p.batchVersionId=g.batchVersionId AND b.currentVersionId=g.batchVersionId
        AND g.projectId=? AND b.projectId=g.projectId AND b.id=? AND b.deletedAt IS NULL
        AND e.selectionStageId=(SELECT id FROM batch_formula_stages WHERE planId=p.id AND kind='select' ORDER BY revision DESC LIMIT 1)`)
      .get(expected.outputVersionId, planId, timelineStageId, selectionStageId, projectId, batchId) as { arrangementJson: string } | undefined;
    if (!row) throw new BatchDomainError('not_found', '当前成片音乐不存在，请刷新');
    const source = readFormulaMusicSource(JSON.parse(row.arrangementJson).music);
    if (!source || source.trackId !== trackId || source.fileFingerprint !== expected.sourceFingerprint) {
      throw new BatchDomainError('conflict', '当前成片音乐已变化，请刷新');
    }
    return source;
  };
  const source = read();
  let absolutePath: string;
  let identity: ReturnType<typeof projectAssetFileIdentity>;
  try {
    absolutePath = assertNoStorageSymlink(path.join(dataRoot(), 'storage'), source.relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error();
    identity = projectAssetFileIdentity(stat);
  } catch { throw new BatchDomainError('conflict', '已选音乐文件缺失或不可读取，请重新选择'); }
  if (!fingerprintsEqual(await computeFingerprintFromFile(absolutePath), source.fileFingerprint)) {
    throw new BatchDomainError('conflict', '已选音乐文件内容已变化，请重新选择');
  }
  if (JSON.stringify(read()) !== JSON.stringify(source)) throw new BatchDomainError('conflict', '音乐来源已变化，请刷新');
  assertProjectAssetFileIdentity(absolutePath, identity);
  const mimeType = ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac' } as Record<string, string>)[path.extname(absolutePath).toLowerCase()] ?? 'application/octet-stream';
  return { absolutePath, identity, mimeType };
}
