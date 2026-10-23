import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { readBatchBgmPool, type BatchBgmPoolEntry } from '../bgm.ts';
import { BatchDomainError } from '../errors.ts';
import type { FormulaGenerationRequest } from './generation.ts';
import { DEFAULT_MUSIC_DUCKING } from '../../media-core/music-ducking.ts';

/** Freeze the chosen file, not just an ID that may later point at different music. */
export function selectFormulaOutputMusic(request: FormulaGenerationRequest, planId: string) {
  const mode = request.input.settings.settings.bgm.mode;
  if (mode === 'none') return { trackId: null, source: null, ducking: { ...DEFAULT_MUSIC_DUCKING } };
  const pool = request.input.musicPool;
  if (!pool.length) throw new BatchDomainError('conflict', '已冻结的音乐候选为空，请重新核对制作设置');
  const index = createHash('sha256').update(JSON.stringify(['formula-music/1', request.seed, planId])).digest().readUInt32BE(0) % pool.length;
  const source = { ...pool[index] };
  return { trackId: source.trackId, source, ducking: { ...DEFAULT_MUSIC_DUCKING } };
}

export function readFormulaMusicSource(value: unknown): BatchBgmPoolEntry | null {
  const music = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (!music.trackId) return null;
  const source = music.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object' || Array.isArray(source) || source.trackId !== music.trackId
    || typeof source.relativePath !== 'string' || !source.relativePath.replaceAll('\\', '/').startsWith('bgm/')
    || typeof source.fileFingerprint !== 'string' || !source.fileFingerprint
    || !Number.isSafeInteger(source.durationUs) || Number(source.durationUs) <= 0) {
    throw new BatchDomainError('conflict', '这首音乐缺少已保存的文件依据，请重新应用音乐选择');
  }
  return { trackId: String(source.trackId), relativePath: source.relativePath,
    fileFingerprint: source.fileFingerprint, durationUs: Number(source.durationUs) };
}

/** An explicit new choice freezes the catalogue entry; parameter edits keep the old file. */
export function freezeFormulaMusicEdit(db: Database.Database, current: Record<string, unknown>, trackId: string | null,
  restoreFingerprint?: unknown) {
  const history: BatchBgmPoolEntry[] = [];
  for (const entry of [...(Array.isArray(current.sourceHistory) ? current.sourceHistory : []), current.source]) {
    if (!entry || typeof entry !== 'object') continue;
    try {
      const source = readFormulaMusicSource({ trackId: entry.trackId, source: entry });
      if (source && !history.some(item => item.trackId === source.trackId && item.fileFingerprint === source.fileFingerprint)) history.push(source);
    } catch { /* A broken old reference must not prevent choosing no music or a new valid file. */ }
  }
  if (!trackId) return { ...current, trackId: null, source: null, sourceHistory: history };
  let source: BatchBgmPoolEntry | null | undefined;
  if (restoreFingerprint !== undefined) {
    source = history.find(entry => entry.trackId === trackId && entry.fileFingerprint === restoreFingerprint);
    if (!source) throw new BatchDomainError('invalid_input', '恢复快照的音乐来源不属于这份成片');
  } else if (current.trackId === trackId && current.source) {
    source = readFormulaMusicSource(current);
  } else source = readBatchBgmPool(db).find(entry => entry.trackId === trackId);
  if (!source) throw new BatchDomainError('invalid_input', 'BGM 曲目不在当前 ready 曲库中');
  return { ...current, trackId, source: readFormulaMusicSource({ trackId, source }), sourceHistory: history };
}
