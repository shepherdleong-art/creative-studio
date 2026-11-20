import { tryFilmRequestLock } from './request-lock.ts';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.ts';
import { dataRoot } from '../data-root.ts';
import { probeDurationSec } from '../ffmpeg.ts';
import { getFinalEditTtsAdapter, listFinalEditTtsAdapters } from '../media-core/adapters/tts-registry.ts';
import { OneClickFilmError } from './errors.ts';
import { getEntry, type OneClickFilmEntry, type OneClickFilmRun } from './store.ts';
import { registerManagedFile } from '../media-core/access-context.ts';

/**
 * TTS 配音（07）：把每条口播交给共享 TTS 适配器，保存实测时长与确认状态。
 *
 * 红线：只有播放过当前版本的配音才能确认；口播、服务、音色或语速变化后，
 * 旧音频仍属于原版本，新稿必须重新生成。配音超过正文时长时保留完整尾句并阻止提交。
 */

export interface NarrationRecord {
  id: string;
  entryCode: string;
  providerId: string;
  voice: string;
  speed: number;
  text: string;
  durationUs: number;
  status: 'queued' | 'running' | 'ready' | 'failed';
  listened: boolean;
  confirmed: boolean;
  url: string | null;
  errorMessage: string | null;
  current: boolean;
}

export function narrationSignature(input: {
  text: string;
  providerId: string;
  voice: string;
  speed: number;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      text: input.text.replace(/\s/g, ''),
      providerId: input.providerId,
      voice: input.voice,
      speed: Number(input.speed.toFixed(2)),
    }))
    .digest('hex')
    .slice(0, 32);
}

function storageRelative(absolutePath: string): string {
  const root = path.resolve(path.join(dataRoot(), 'storage'));
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

export function listNarrations(db: Database.Database, run: OneClickFilmRun): NarrationRecord[] {
  const rows = db.prepare(`
    SELECT * FROM one_click_film_narrations WHERE runId = ? ORDER BY entryCode ASC, createdAt DESC
  `).all(run.id) as Array<{
    id: string; entryCode: string; providerId: string; voice: string; speed: number; text: string;
    relativePath: string; durationUs: number; status: NarrationRecord['status'];
    listenedAt: string | null; confirmedAt: string | null; errorMessage: string | null; signature: string;
  }>;
  const entries = new Map((db.prepare(`SELECT id, code, narration, soundMode, ttsProviderId, ttsVoice, ttsSpeed
    FROM one_click_film_entries WHERE runId = ?`).all(run.id) as Array<{
      id: string; code: string; narration: string; soundMode: string; ttsProviderId: string; ttsVoice: string; ttsSpeed: number;
    }>).map((entry) => [entry.code, entry]));
  return rows.map((row) => {
    const entry = entries.get(row.entryCode);
    const current = Boolean(entry) && narrationSignature({
      text: entry!.narration,
      providerId: entry!.ttsProviderId,
      voice: entry!.ttsVoice,
      speed: entry!.ttsSpeed,
    }) === row.signature;
    return {
      id: row.id,
      entryCode: row.entryCode,
      providerId: row.providerId,
      voice: row.voice,
      speed: row.speed,
      text: row.text,
      durationUs: row.durationUs,
      status: row.status,
      listened: Boolean(row.listenedAt),
      confirmed: Boolean(row.confirmedAt),
      url: row.status === 'ready' && row.relativePath
        ? `/api/one-click-film/${encodeURIComponent(run.projectId)}/narration?audio=${encodeURIComponent(row.id)}` : null,
      errorMessage: row.errorMessage,
      current,
    };
  });
}

export function listTtsProviders(db: Database.Database): Array<{
  id: string; name: string; voices: Array<{ id: string; label: string }>; defaultVoice: string;
}> {
  const rows = db.prepare(`SELECT id, name FROM final_edit_tts_providers WHERE enabled = 1 ORDER BY isBuiltin DESC, name`)
    .all() as Array<{ id: string; name: string }>;
  return rows.flatMap((row) => {
    const adapter = listFinalEditTtsAdapters().find((item) => item.id === row.id);
    if (!adapter) return [];
    return [{
      id: row.id,
      name: row.name,
      voices: adapter.voices.map((voice) => ({ id: voice.id, label: voice.label })),
      defaultVoice: adapter.defaultVoice,
    }];
  });
}

function providerConfig(db: Database.Database, providerId: string) {
  const row = db.prepare(`SELECT id, name, type, baseUrl, apiKey, keyEnv, model, enabled FROM final_edit_tts_providers WHERE id = ?`)
    .get(providerId) as {
      id: string; name: string; type: string; baseUrl: string; apiKey: string; keyEnv: string; model: string; enabled: number;
    } | undefined;
  if (!row || row.enabled !== 1) throw new OneClickFilmError('invalid_input', '口播配音供应商未启用');
  return row;
}

export function configureNarrations(db: Database.Database, input: {
  run: OneClickFilmRun; providerId: string; voice: string; speed: number;
}): string[] {
  const provider = listTtsProviders(db).find((item) => item.id === input.providerId);
  if (!provider?.voices.some((item) => item.id === input.voice) || !Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2) {
    throw new OneClickFilmError('invalid_input', '请选择有效的配音服务、音色及 0.5–2 倍语速');
  }
  const rows = db.prepare(`SELECT code FROM one_click_film_entries WHERE runId=? AND retired=0 AND soundMode='tts'
    AND (ttsProviderId<>? OR ttsVoice<>? OR ttsSpeed<>?)`).all(input.run.id, input.providerId, input.voice, input.speed) as { code: string }[];
  db.prepare(`
    UPDATE one_click_film_entries SET ttsProviderId=?, ttsVoice=?, ttsSpeed=?, status='pending',
      scriptConfirmedAt=NULL, scriptConfirmedJson='{}', updatedAt=datetime('now')
    WHERE runId=? AND retired=0 AND soundMode='tts' AND (ttsProviderId<>? OR ttsVoice<>? OR ttsSpeed<>?)
  `).run(input.providerId, input.voice, input.speed, input.run.id, input.providerId, input.voice, input.speed);
  return rows.map((row) => row.code);
}

/**
 * 生成一条或整批配音。signature 已存在时复用，不重复计费；
 * 迟到的旧结果仍写回自己的签名行，不会覆盖新版本。
 */
export async function synthesizeNarrations(input: {
  run: OneClickFilmRun;
  codes?: string[];
  db?: Database.Database;
}): Promise<NarrationRecord[]> {
  const db = input.db ?? getDb();
  const all = db.prepare(`SELECT code FROM one_click_film_entries WHERE runId = ? AND retired=0 ORDER BY ordinal`)
    .all(input.run.id) as Array<{ code: string }>;
  const codes = input.codes?.length ? input.codes : all.map((row) => row.code);

  for (const code of codes) {
    const entry = getEntry(db, input.run.id, code);
    if (entry.soundMode !== 'tts') {
      throw new OneClickFilmError('invalid_input', `${entry.code} 没有选择 TTS 统一旁白`);
    }
    if (!entry.narration.trim()) throw new OneClickFilmError('invalid_input', `${entry.code} 的口播为空`);
    const providerId = entry.ttsProviderId;
    if (!providerId) throw new OneClickFilmError('invalid_input', `${entry.code} 还没有选择配音服务`);
    const signature = narrationSignature({
      text: entry.narration, providerId, voice: entry.ttsVoice, speed: entry.ttsSpeed,
    });
    const lock = await tryFilmRequestLock('narration', [entry.id, signature]);
    if (!lock) continue;
    try {
      const existing = db.prepare(`
        SELECT id, status FROM one_click_film_narrations WHERE entryId = ? AND signature = ?
      `).get(entry.id, signature) as { id: string; status: string } | undefined;
      if (existing?.status === 'ready') continue;

      const now = new Date().toISOString();
      const id = existing?.id ?? uuidv4();
      if (existing) {
        db.prepare(`UPDATE one_click_film_narrations SET status = 'running', errorMessage = NULL, updatedAt = ? WHERE id = ?`)
          .run(now, id);
      } else {
        db.prepare(`
          INSERT INTO one_click_film_narrations
            (id, runId, projectId, entryId, entryCode, signature, providerId, voice, speed, text, status, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
        `).run(
          id, input.run.id, input.run.projectId, entry.id, entry.code, signature,
          providerId, entry.ttsVoice, entry.ttsSpeed, entry.narration, now, now,
        );
      }

      try {
        const provider = providerConfig(db, providerId);
        const adapter = getFinalEditTtsAdapter(providerId);
        const outputDir = path.join(dataRoot(), 'storage', 'one-click-film', 'narration', input.run.id, entry.id, signature);
        fs.mkdirSync(outputDir, { recursive: true });
        const relativeOutputPath = path.join(
          storageRelative(outputDir),
          'narration.wav',
        );
        const absolutePath = path.join(dataRoot(), 'storage', relativeOutputPath);
        const result = await adapter.synthesize({
          provider: {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey || (provider.keyEnv ? process.env[provider.keyEnv] || '' : ''),
            model: provider.model,
            providerId: provider.id,
            providerName: provider.name,
            providerType: provider.type,
          },
          voice: entry.ttsVoice || adapter.defaultVoice,
          speed: entry.ttsSpeed || 1,
          segments: [{ segmentId: entry.code, narration: entry.narration }],
          outputDir,
          relativeOutputPath,
          alignment: { configured: false, align: async () => [] },
          usageContext: { projectId: input.run.projectId, refType: 'one-click-film-narration', refId: id },
        });
        const durationSec = result.durationUs > 0 ? result.durationUs / 1e6 : await probeDurationSec(absolutePath);
        const durationUs = Math.max(0, Math.round(durationSec * 1_000_000));
        if (!durationUs) throw new Error('配音音频无法读取');
        db.transaction(() => {
          registerManagedFile({ absolutePath, mimeType: 'audio/wav',
            references: [{ resourceType: 'project', resourceId: input.run.projectId, role: 'derivative' }] });
          db.prepare(`
            UPDATE one_click_film_narrations
            SET status = 'ready', relativePath = ?, durationUs = ?, errorMessage = NULL, updatedAt = ?
            WHERE id = ?
          `).run(relativeOutputPath, durationUs, new Date().toISOString(), id);
        }).immediate();
      } catch (error) {
        db.prepare(`
          UPDATE one_click_film_narrations SET status = 'failed', errorMessage = ?, updatedAt = ? WHERE id = ?
        `).run(
          (error instanceof Error ? error.message : String(error)).slice(0, 500),
          new Date().toISOString(), id,
        );
      }
    } finally {
      lock.release();
    }
  }
  return listNarrations(db, input.run);
}

/** 只有播放过当前版本的配音才能确认。 */
export function confirmNarration(db: Database.Database, input: {
  run: OneClickFilmRun;
  narrationId: string;
  listened: boolean;
}): NarrationRecord[] {
  const row = db.prepare(`SELECT * FROM one_click_film_narrations WHERE id = ? AND runId = ?`)
    .get(input.narrationId, input.run.id) as { id: string; status: string; listenedAt: string | null } | undefined;
  if (!row) throw new OneClickFilmError('not_found', '配音不存在', 404);
  if (row.status !== 'ready') throw new OneClickFilmError('invalid_input', '配音还没生成完成');
  if (!row.listenedAt || !listNarrations(db, input.run).find((record) => record.id === row.id)?.current) {
    throw new OneClickFilmError('invalid_input', '请先试听当前版本的配音再确认');
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE one_click_film_narrations SET listenedAt = COALESCE(listenedAt, ?), confirmedAt = ?, updatedAt = ? WHERE id = ?`)
    .run(now, now, now, row.id);
  return listNarrations(db, input.run);
}

/** 试听标记：只记「播放过当前版本」，不等于确认。 */
export function markNarrationListened(db: Database.Database, input: {
  run: OneClickFilmRun;
  narrationId: string;
}): NarrationRecord[] {
  const row = db.prepare(`SELECT id, status FROM one_click_film_narrations WHERE id = ? AND runId = ?`)
    .get(input.narrationId, input.run.id) as { id: string; status: string } | undefined;
  if (!row) throw new OneClickFilmError('not_found', '配音不存在', 404);
  if (row.status !== 'ready') throw new OneClickFilmError('invalid_input', '配音还没生成完成');
  const now = new Date().toISOString();
  db.prepare(`UPDATE one_click_film_narrations SET listenedAt = COALESCE(listenedAt, ?), updatedAt = ? WHERE id = ?`)
    .run(now, now, row.id);
  return listNarrations(db, input.run);
}

/** 整批视频生成前的配音闸门：采用 TTS 的条目必须有当前且已确认的配音，且不超正文时长。 */
export function narrationGate(db: Database.Database, entries: OneClickFilmEntry[], durationSec?: number): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.soundMode !== 'tts') continue;
    const signature = narrationSignature({
      text: entry.narration, providerId: entry.ttsProviderId, voice: entry.ttsVoice, speed: entry.ttsSpeed,
    });
    const row = db.prepare(`
      SELECT status, durationUs, confirmedAt FROM one_click_film_narrations WHERE entryId = ? AND signature = ?
    `).get(entry.id, signature) as { status: string; durationUs: number; confirmedAt: string | null } | undefined;
    if (!row || row.status !== 'ready' || !row.confirmedAt) {
      problems.push(`${entry.code} 需要重新生成并确认配音`);
      continue;
    }
    const duration = durationSec ?? entry.promptDurationSec;
    if (row.durationUs > duration * 1_000_000) {
      problems.push(`${entry.code} 的配音 ${(row.durationUs / 1e6).toFixed(1)} 秒超过正文 ${duration} 秒，请改文案、调语速或选更长正文`);
    }
  }
  return problems;
}
