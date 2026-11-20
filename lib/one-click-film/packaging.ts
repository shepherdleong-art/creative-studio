import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { OneClickFilmError } from './errors.ts';
import type { OneClickFilmRun } from './store.ts';
import {
  isOneClickFilmTemplate,
  ONE_CLICK_FILM_TEMPLATE_IDS,
  ONE_CLICK_FILM_TEMPLATE_LABELS,
  type OneClickFilmTemplateId,
} from './packaging-constants.ts';

/**
 * 一键批量包装（13）与包装后继续编辑（14）。
 *
 * 红线：封面只在包装时加入；正文为 24 fps 下 360 帧，启用封面加 20 帧共 380 帧。
 * 字幕与花字随正文顺延一次，预览与渲染使用同一偏移。包装修订与画面审片分开记录。
 */

export { ONE_CLICK_FILM_TEMPLATE_IDS, ONE_CLICK_FILM_TEMPLATE_LABELS };
export type PackagingTemplateId = OneClickFilmTemplateId;

export interface PackagingOptions {
  template: PackagingTemplateId;
  cover: boolean;
  subtitles: boolean;
  decoration: boolean;
  bgm: boolean;
  titleMode: 'auto' | 'shared';
  title: string;
  bgmVolume: number;
}

export interface TextCue {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
}

export interface PackagingRecord {
  id: string;
  entryCode: string;
  status: 'pending' | 'ready' | 'failed';
  template: PackagingTemplateId;
  options: PackagingOptions;
  title: string;
  subtitleCues: TextCue[];
  pointCues: TextCue[];
  revision: number;
  ready: boolean;
  reason: string | null;
  errorMessage: string | null;
}

export const DEFAULT_PACKAGING_OPTIONS: PackagingOptions = {
  template: 'overlay-minimal',
  cover: true,
  subtitles: true,
  decoration: true,
  bgm: true,
  titleMode: 'auto',
  title: '',
  bgmVolume: 18,
};

export function parsePackagingOptions(value: unknown): PackagingOptions {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const template = isOneClickFilmTemplate(raw.template)
    ? raw.template
    : DEFAULT_PACKAGING_OPTIONS.template;
  const volume = Number(raw.bgmVolume);
  return {
    template,
    cover: raw.cover !== false,
    subtitles: raw.subtitles !== false,
    decoration: raw.decoration !== false,
    bgm: raw.bgm !== false,
    titleMode: raw.titleMode === 'shared' ? 'shared' : 'auto',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 60) : '',
    bgmVolume: Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.round(volume))) : DEFAULT_PACKAGING_OPTIONS.bgmVolume,
  };
}

/** 正文按句切分做口播字幕；不配音时跳过口播字幕。 */
export function buildSubtitleCues(input: {
  narration: string;
  soundMode: 'native' | 'tts' | 'none';
  durationSec: number;
  audioDurationUs?: number;
}): TextCue[] {
  if (input.soundMode === 'none') return [];
  const lines = (input.narration.match(/[^。！？!?\n]+[。！？!?]?/g) || []).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const spoken = input.soundMode === 'tts' && input.audioDurationUs
    ? Math.min(input.durationSec, input.audioDurationUs / 1e6)
    : input.durationSec;
  const step = spoken / lines.length;
  return lines.map((text, index) => ({
    id: `sub-${index}`,
    text,
    startSec: Number((index * step).toFixed(2)),
    endSec: Number(((index + 1) * step).toFixed(2)),
  }));
}

export function buildDecorationCues(input: {
  title: string;
  points: string[];
  durationSec: number;
}): TextCue[] {
  const texts = [input.title, ...input.points].map((text) => text.trim()).filter(Boolean).slice(0, 3);
  if (texts.length === 0) return [];
  const step = input.durationSec / texts.length;
  return texts.map((text, index) => ({
    id: `dec-${index}`,
    text,
    startSec: Number((index * step).toFixed(2)),
    endSec: Number(((index + 1) * step).toFixed(2)),
  }));
}

/** 包装资格：直出审片通过，或样片转高清且复核通过。 */
export function packagingEligibility(db: Database.Database, run: OneClickFilmRun, entryCode: string): {
  ready: boolean;
  reason: string;
} {
  const review = db.prepare(`SELECT id, approvedAt FROM one_click_film_reviews WHERE runId = ? AND entryCode = ?`)
    .get(run.id, entryCode) as { id: string; approvedAt: string | null } | undefined;
  if (!review) return { ready: false, reason: '还没有生成原片' };
  if (!review.approvedAt) return { ready: false, reason: '待审片' };
  const job = db.prepare(`
    SELECT generationMode FROM one_click_film_video_jobs WHERE runId = ? AND entryCode = ? ORDER BY createdAt DESC LIMIT 1
  `).get(run.id, entryCode) as { generationMode: string } | undefined;
  if (job?.generationMode === 'draft') {
    const hd = db.prepare(`SELECT status FROM one_click_film_hd_sources WHERE runId = ? AND entryCode = ? LIMIT 1`)
      .get(run.id, entryCode) as { status: string } | undefined;
    if (!hd || hd.status !== 'ready') return { ready: false, reason: '样片待转高清并复核' };
  }
  return { ready: true, reason: '' };
}

export function listPackaging(db: Database.Database, run: OneClickFilmRun): PackagingRecord[] {
  const rows = db.prepare(`SELECT * FROM one_click_film_packaging WHERE runId = ? ORDER BY entryCode`)
    .all(run.id) as Array<{
      id: string; entryCode: string; status: PackagingRecord['status']; template: PackagingTemplateId;
      optionsJson: string; title: string; subtitleCuesJson: string; pointCuesJson: string;
      revision: number; errorMessage: string | null;
    }>;
  return rows.map((row) => {
    const eligibility = packagingEligibility(db, run, row.entryCode);
    return {
      id: row.id,
      entryCode: row.entryCode,
      status: row.status,
      template: row.template,
      options: parsePackagingOptions(row.optionsJson),
      title: row.title,
      subtitleCues: parseCues(row.subtitleCuesJson),
      pointCues: parseCues(row.pointCuesJson),
      revision: row.revision,
      ready: eligibility.ready && row.status === 'ready',
      reason: eligibility.ready ? (row.status === 'ready' ? null : '待包装') : eligibility.reason,
      errorMessage: row.errorMessage,
    };
  });
}

function parseCues(value: string): TextCue[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      if (typeof record.text !== 'string' || !record.text.trim()) return [];
      const startSec = Number(record.startSec);
      const endSec = Number(record.endSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return [];
      return [{
        id: typeof record.id === 'string' ? record.id : `cue-${startSec}`,
        text: record.text.slice(0, 60),
        startSec, endSec,
      }];
    });
  } catch {
    return [];
  }
}

/**
 * 一键包装：只处理合格条目，逐条按自己的当前版本与标题准备包装。
 * 单条失败不影响其他条目，重试不会重复加封面或再次平移时间。
 */
export function preparePackaging(db: Database.Database, input: {
  run: OneClickFilmRun;
  options: unknown;
  codes?: string[];
}): Array<{ entryCode: string; ok: boolean; reason?: string }> {
  const options = parsePackagingOptions(input.options);
  const entries = db.prepare(`SELECT id, code, narration, soundMode, promptDurationSec FROM one_click_film_entries
    WHERE runId = ? ORDER BY ordinal`).all(input.run.id) as Array<{
      id: string; code: string; narration: string; soundMode: 'native' | 'tts' | 'none'; promptDurationSec: number;
    }>;
  const targets = input.codes?.length ? entries.filter((entry) => input.codes!.includes(entry.code)) : entries;
  const results: Array<{ entryCode: string; ok: boolean; reason?: string }> = [];
  const now = new Date().toISOString();

  for (const entry of targets) {
    const eligibility = packagingEligibility(db, input.run, entry.code);
    if (!eligibility.ready) {
      results.push({ entryCode: entry.code, ok: false, reason: eligibility.reason });
      continue;
    }
    const title = options.titleMode === 'shared' && options.title.trim() ? options.title.trim() : entry.code;
    const narrationAudio = db.prepare(`
      SELECT durationUs FROM one_click_film_narrations WHERE entryId = ? AND status = 'ready'
      ORDER BY createdAt DESC LIMIT 1
    `).get(entry.id) as { durationUs: number } | undefined;
    const subtitleCues = options.subtitles
      ? buildSubtitleCues({
          narration: entry.narration,
          soundMode: entry.soundMode,
          durationSec: entry.promptDurationSec,
          audioDurationUs: narrationAudio?.durationUs,
        })
      : [];
    const pointCues = options.decoration
      ? buildDecorationCues({ title, points: [], durationSec: entry.promptDurationSec })
      : [];
    db.prepare(`
      INSERT INTO one_click_film_packaging
        (id, runId, entryId, entryCode, status, template, optionsJson, title, subtitleCuesJson,
         pointCuesJson, revision, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(entryId) DO UPDATE SET
        status = 'ready', template = excluded.template, optionsJson = excluded.optionsJson,
        title = excluded.title, subtitleCuesJson = excluded.subtitleCuesJson,
        pointCuesJson = excluded.pointCuesJson, revision = one_click_film_packaging.revision + 1,
        errorMessage = NULL, updatedAt = excluded.updatedAt
    `).run(
      uuidv4(), input.run.id, entry.id, entry.code, options.template,
      JSON.stringify(options), title, JSON.stringify(subtitleCues), JSON.stringify(pointCues), now, now,
    );
    results.push({ entryCode: entry.code, ok: true });
  }
  return results;
}

/**
 * 包装后继续编辑：只保存当前条。文字与起止时间以正文第 0 秒计，
 * 加封面后由同一偏移顺延到成片第 20 帧。
 */
export function updatePackagingDraft(db: Database.Database, input: {
  run: OneClickFilmRun;
  entryCode: string;
  title?: string;
  template?: string;
  subtitleCues?: TextCue[];
  pointCues?: TextCue[];
  bgmVolume?: number;
}): PackagingRecord[] {
  const row = db.prepare(`SELECT * FROM one_click_film_packaging WHERE runId = ? AND entryCode = ?`)
    .get(input.run.id, input.entryCode) as { id: string; optionsJson: string } | undefined;
  if (!row) throw new OneClickFilmError('not_found', '这条成片还没有包装记录', 404);
  const options = parsePackagingOptions(row.optionsJson);
  if (isOneClickFilmTemplate(input.template)) {
    options.template = input.template;
  }
  if (typeof input.bgmVolume === 'number') {
    options.bgmVolume = Math.max(0, Math.min(100, Math.round(input.bgmVolume)));
  }
  const durationSec = (db.prepare(`SELECT promptDurationSec FROM one_click_film_entries WHERE runId = ? AND code = ?`)
    .get(input.run.id, input.entryCode) as { promptDurationSec: number } | undefined)?.promptDurationSec ?? 15;
  const normalize = (cues: TextCue[] | undefined, fallback: string): string => {
    if (!cues) return fallback;
    const cleaned = cues
      .filter((cue) => cue.text.trim() && cue.endSec > cue.startSec)
      .map((cue) => ({
        ...cue,
        text: cue.text.slice(0, 60),
        startSec: Math.max(0, Math.min(durationSec, cue.startSec)),
        endSec: Math.max(0, Math.min(durationSec, cue.endSec)),
      }));
    return JSON.stringify(cleaned);
  };
  const current = db.prepare(`SELECT subtitleCuesJson, pointCuesJson, title FROM one_click_film_packaging WHERE id = ?`)
    .get(row.id) as { subtitleCuesJson: string; pointCuesJson: string; title: string };
  db.prepare(`
    UPDATE one_click_film_packaging
    SET title = ?, template = ?, optionsJson = ?, subtitleCuesJson = ?, pointCuesJson = ?,
        revision = revision + 1, status = 'ready', updatedAt = ?
    WHERE id = ?
  `).run(
    typeof input.title === 'string' ? input.title.slice(0, 60) : current.title,
    options.template, JSON.stringify(options),
    normalize(input.subtitleCues, current.subtitleCuesJson),
    normalize(input.pointCues, current.pointCuesJson),
    new Date().toISOString(), row.id,
  );
  return listPackaging(db, input.run);
}

/**
 * 时间基准：正文第 0 帧在启用封面时对应成片第 20 帧（24 fps）。
 * 字幕和花字只顺延这一次。
 */
export function filmTimeForBodyTime(bodySec: number, cover: boolean): { sec: number; frame: number } {
  const offsetSec = cover ? 20 / 24 : 0;
  const sec = bodySec + offsetSec;
  return { sec: Number(sec.toFixed(3)), frame: Math.round(sec * 24) };
}
