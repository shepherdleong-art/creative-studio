import { parsePackagingConfig } from '../media-core/packaging-vars.ts';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { upgradeColorSnapshot, type ColorSnapshotV1 } from './color-pipeline.ts';
import {
  loadFrozenCoverTitleConfig,
  resolveBatchCoverTitleOverride,
} from './cover-title.ts';
import type { CoverFraming, TextStyle } from '../media-core/cover-types.ts';
import { BATCH_OUTPUT_PRESETS, type BatchOutputPreset } from './output-presets.ts';
import { readFormulaOutputAudioPlan, readFormulaOutputBasis } from './formula/output-audio.ts';
import { readFormulaMusicSource } from './formula/output-music.ts';
import { readMusicDucking } from '../media-core/music-ducking.ts';
import { normalizeNarrationGainDb } from '../media-core/audio-gain.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../media-core/render-contract.ts';
import { loadFrozenSubtitleStyle, resolveBatchSubtitleStyle, resolveBatchSubtitleStyleOverride } from './subtitle-style.ts';

export const BATCH_COVER_RENDERER_VERSION = 'batch-cover-v1';
export const BATCH_FULL_RENDER_ADAPTER_VERSION = 'batch-render-v3';

export interface CoverContractInput {
  outputVersionId: string;
  coverRendererVersion: string;
  assetId: string;
  assetFingerprint: string;
  timeUs: number;
  preset: string;
  outputWidth: number;
  outputHeight: number;
  colorSnapshot: ColorSnapshotV1;
  lutFingerprint: string | null;
  framing: CoverFraming | null;
  title: {
    primary: string;
    secondary: string;
    styles: { primary: TextStyle; secondary: TextStyle };
  } | null;
}

export interface FullRenderContractInput {
  /** Formula audio is a sequence of real sources, not a legacy whole-script narration. */
  formula?: {
    version: 'formula-render/1' | 'formula-render/2';
    basis: NonNullable<ReturnType<typeof readFormulaOutputBasis>>;
    audioPlan: Pick<NonNullable<ReturnType<typeof readFormulaOutputAudioPlan>>, 'version' | 'bodyDurationUs' | 'clips'>;
    narrationGainDb: number;
    musicSource: ReturnType<typeof readFormulaMusicSource>;
    musicDucking: ReturnType<typeof readMusicDucking>;
    musicDefaults: unknown;
    subtitleStyle: TextStyle;
    fps: number;
    introFrames: number;
    videoSources: Array<{ clipId: string; assetId: string; assetFingerprint: string; colorSnapshot: ColorSnapshotV1 }>;
  };
  packaging?: unknown;
  outputVersionId: string;
  editRevision: number;
  audio?: unknown;
  preserveGaps?: boolean;
  adapterVersion: string;
  preset: string;
  outputWidth: number;
  outputHeight: number;
  coverContractHash: string;
  clips: Array<{
    clipId: string;
    formulaSourceId?: string;
    assetId: string;
    sourceStartUs: number;
    sourceEndUs: number;
    timelineStartUs: number;
    timelineEndUs: number;
    framing?: unknown;
  }>;
  narration: {
    relativePath?: string;
    fingerprint?: string;
    durationUs?: number;
  } | null;
  subtitles: {
    cues?: unknown[];
    style?: unknown;
  } | null;
  music: {
    trackId?: unknown;
    gainDb?: unknown;
    fadeInSec?: unknown;
    fadeOutSec?: unknown;
  } | null;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computeCoverContractHash(input: CoverContractInput): string {
  const serialized = canonicalJson(input);
  const digest = crypto.createHash('sha256').update(serialized).digest('hex');
  return `cov_${digest.slice(0, 32)}`;
}

export function computeFullRenderContractHash(input: FullRenderContractInput): string {
  const serialized = canonicalJson(input);
  const digest = crypto.createHash('sha256').update(serialized).digest('hex');
  return `rnd_${digest.slice(0, 32)}`;
}

export function resolveCoverContract(
  db: Database.Database,
  outputVersionId: string,
  /**
   * 冻结输入覆盖:渲染执行器把 loadSnapshot 拿到的原始 arrangementJson 传进来,
   * 契约哈希只由渲染所依据的冻结输入决定——渲染期间用户又编辑(同版本)时,
   * 不会把旧画面标成新契约哈希。
   */
  frozenArrangementJson?: string,
): CoverContractInput {
  const row = db.prepare(`
    SELECT
      o.id AS outputVersionId,
      o.planId AS planId,
      o.arrangementJson AS arrangementJson,
      p.batchVersionId AS batchVersionId,
      p.seq AS planSeq,
      v.defaultsJson AS defaultsJson
    FROM batch_output_versions o
    JOIN batch_output_plans p ON p.id = o.planId
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    WHERE o.id = ?
  `).get(outputVersionId) as {
    outputVersionId: string;
    planId: string;
    arrangementJson: string;
    batchVersionId: string;
    planSeq: number;
    defaultsJson: string;
  } | undefined;
  if (!row) throw new Error(`outputVersion ${outputVersionId} 不存在`);

  let arrangement: Record<string, unknown>;
  try {
    arrangement = JSON.parse(frozenArrangementJson ?? row.arrangementJson) as Record<string, unknown>;
  } catch {
    throw new Error('arrangementJson 无法解析');
  }
  const clips = Array.isArray(arrangement.clips) ? arrangement.clips as Array<Record<string, unknown>> : [];
  if (clips.length === 0) throw new Error('arrangement clips 不能为空');

  const preset = (typeof arrangement.preset === 'string' ? arrangement.preset : '3:4') as BatchOutputPreset;
  const outputSize = BATCH_OUTPUT_PRESETS[preset] ?? BATCH_OUTPUT_PRESETS['3:4'];

  const cover = arrangement.cover && typeof arrangement.cover === 'object' && !Array.isArray(arrangement.cover)
    ? arrangement.cover as Record<string, unknown>
    : null;

  const firstClip = clips[0];
  const coverClipId = typeof cover?.clipId === 'string' ? cover.clipId : typeof cover?.segmentId === 'string' ? cover.segmentId : null;
  const selectedClip = coverClipId
    ? clips.find((c) => c.clipId === coverClipId || c.segmentId === coverClipId)
    : undefined;

  const assetId = typeof cover?.assetId === 'string'
    ? cover.assetId
    : typeof selectedClip?.assetId === 'string'
      ? selectedClip.assetId
      : String(firstClip.assetId);

  const requestedTime = cover?.timeUs ?? cover?.frameTimeUs ?? cover?.sourceTimeUs;
  const defaultTimeUs = selectedClip?.sourceStartUs != null
    ? Number(selectedClip.sourceStartUs)
    : (cover?.assetId ? 0 : Number(firstClip.sourceStartUs || 0));
  const timeUs = requestedTime == null ? defaultTimeUs : Number(requestedTime);

  const asset = db.prepare(`SELECT contentFingerprint FROM batch_assets WHERE id = ?`).get(assetId) as { contentFingerprint: string } | undefined;
  if (!asset) throw new Error(`素材 ${assetId} 不存在`);

  const poolItem = db.prepare(`SELECT colorJson FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?`).get(row.batchVersionId, assetId) as { colorJson: string } | undefined;
  let colorJsonStr = poolItem?.colorJson;
  // Formula sources need not be in the old pool. Match the renderer's frozen
  // neutral fallback; analysis is neither a color snapshot nor a color table.
  if (!colorJsonStr && arrangement.formula !== undefined) colorJsonStr = '{"lutId":null}';
  if (!colorJsonStr) {
    const analysis = db.prepare(`SELECT colorJson FROM batch_asset_analysis WHERE assetId = ? ORDER BY createdAt DESC LIMIT 1`).get(assetId) as { colorJson: string } | undefined;
    colorJsonStr = analysis?.colorJson ?? '{"lutId":null}';
  }

  const colorSnapshot = upgradeColorSnapshot(JSON.parse(colorJsonStr));
  const lutFingerprint = colorSnapshot.lutFingerprint ?? null;

  const frozenTitleConfig = loadFrozenCoverTitleConfig(db, row.planId);
  const override = resolveBatchCoverTitleOverride(frozenTitleConfig, cover, outputSize.width);

  const title = override && (override.primary || override.secondary)
    ? {
        primary: override.primary,
        secondary: override.secondary,
        styles: override.styles,
      }
    : null;
  const framing = override?.framing ?? null;

  return {
    outputVersionId: row.outputVersionId,
    coverRendererVersion: BATCH_COVER_RENDERER_VERSION,
    assetId,
    assetFingerprint: asset.contentFingerprint,
    timeUs,
    preset,
    outputWidth: outputSize.width,
    outputHeight: outputSize.height,
    colorSnapshot,
    lutFingerprint,
    framing,
    title,
  };
}

export function resolveCoverContractHash(
  db: Database.Database,
  outputVersionId: string,
  frozenArrangementJson?: string,
): string {
  return computeCoverContractHash(resolveCoverContract(db, outputVersionId, frozenArrangementJson));
}

export function resolveFullRenderContract(
  db: Database.Database,
  outputVersionId: string,
  frozenArrangementJson?: string,
): FullRenderContractInput {
  const row = db.prepare(`
    SELECT
      o.id AS outputVersionId,
      o.arrangementJson AS arrangementJson,
      p.batchVersionId AS batchVersionId,
      p.id AS planId,
      v.defaultsJson AS defaultsJson
    FROM batch_output_versions o
    JOIN batch_output_plans p ON p.id = o.planId
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    WHERE o.id = ?
  `).get(outputVersionId) as {
    outputVersionId: string;
    arrangementJson: string;
    batchVersionId: string;
    planId: string;
    defaultsJson: string;
  } | undefined;
  if (!row) throw new Error(`outputVersion ${outputVersionId} 不存在`);

  const arrangement = JSON.parse(frozenArrangementJson ?? row.arrangementJson) as Record<string, unknown>;
  const editRevision = Number.isSafeInteger(Number(arrangement.editRevision)) && Number(arrangement.editRevision) > 0
    ? Number(arrangement.editRevision)
    : 0;
  const preset = (typeof arrangement.preset === 'string' ? arrangement.preset : '3:4') as BatchOutputPreset;
  const outputSize = BATCH_OUTPUT_PRESETS[preset] ?? BATCH_OUTPUT_PRESETS['3:4'];

  const coverContract = resolveCoverContract(db, outputVersionId, frozenArrangementJson);
  const coverContractHash = computeCoverContractHash(coverContract);

  const rawClips = Array.isArray(arrangement.clips) ? arrangement.clips as Array<Record<string, unknown>> : [];
  const clips = rawClips.map((c) => ({
    clipId: String(c.clipId ?? c.id ?? c.segmentId ?? ''),
    ...(typeof c.formulaSourceId === 'string' ? { formulaSourceId: c.formulaSourceId } : {}),
    assetId: String(c.assetId ?? ''),
    sourceStartUs: Number(c.sourceStartUs || 0),
    sourceEndUs: Number(c.sourceEndUs || 0),
    timelineStartUs: Number(c.timelineStartUs ?? c.timelineInUs ?? 0),
    timelineEndUs: Number(c.timelineEndUs ?? c.timelineOutUs ?? 0),
    ...(c.framing ? { framing: c.framing } : {}),
  })).sort((a, b) => a.timelineStartUs - b.timelineStartUs || a.clipId.localeCompare(b.clipId));

  const narrationRaw = arrangement.narration && typeof arrangement.narration === 'object' && !Array.isArray(arrangement.narration)
    ? arrangement.narration as Record<string, unknown>
    : null;
  const narration = narrationRaw && narrationRaw.productionReady === true
    ? {
        relativePath: typeof narrationRaw.relativePath === 'string' ? narrationRaw.relativePath : typeof narrationRaw.audioRelativePath === 'string' ? narrationRaw.audioRelativePath : undefined,
        fingerprint: typeof narrationRaw.fingerprint === 'string' ? narrationRaw.fingerprint : typeof narrationRaw.audioFingerprint === 'string' ? narrationRaw.audioFingerprint : undefined,
        durationUs: Number(narrationRaw.durationUs || 0),
      }
    : null;

  const subtitleRaw = arrangement.subtitle && typeof arrangement.subtitle === 'object' && !Array.isArray(arrangement.subtitle)
    ? arrangement.subtitle as Record<string, unknown>
    : null;
  const subtitles = subtitleRaw
    ? {
        cues: Array.isArray(subtitleRaw.cues) ? subtitleRaw.cues : undefined,
        style: subtitleRaw.style,
      }
    : null;

  const musicRaw = arrangement.music && typeof arrangement.music === 'object' && !Array.isArray(arrangement.music)
    ? arrangement.music as Record<string, unknown>
    : null;
  const music = musicRaw
    ? {
        trackId: musicRaw.trackId,
        gainDb: musicRaw.gainDb,
        fadeInSec: musicRaw.fadeInSec,
        fadeOutSec: musicRaw.fadeOutSec,
      }
    : null;

  let formula: FullRenderContractInput['formula'];
  if (arrangement.planningMode === 'formula' || arrangement.formula !== undefined || arrangement.audioPlan !== undefined) {
    const basis = readFormulaOutputBasis(arrangement.formula);
    const plan = readFormulaOutputAudioPlan(arrangement.audioPlan);
    if (!basis || !plan || !plan.clips.length) throw new Error('公式成片缺少实际声音计划，无法确认渲染版本');
    const defaults = JSON.parse(row.defaultsJson) as Record<string, unknown>;
    formula = {
      version: 'formula-render/2', basis,
      audioPlan: { version: plan.version, bodyDurationUs: plan.bodyDurationUs, clips: plan.clips },
      narrationGainDb: normalizeNarrationGainDb(narrationRaw?.gainDb),
      musicSource: readFormulaMusicSource(musicRaw),
      musicDucking: readMusicDucking(musicRaw?.ducking),
      musicDefaults: defaults.batchBgmParams ?? null,
      subtitleStyle: resolveBatchSubtitleStyleOverride(loadFrozenSubtitleStyle(db, row.planId, outputSize.width)
        ?? resolveBatchSubtitleStyle(defaults, outputSize.width), subtitleRaw),
      fps: FINAL_EDIT_FPS, introFrames: FINAL_EDIT_INTRO_FRAMES,
      videoSources: clips.map(clip => {
        const asset = db.prepare('SELECT contentFingerprint FROM batch_assets WHERE id=?').get(clip.assetId) as { contentFingerprint: string } | undefined;
        if (!asset) throw new Error(`素材 ${clip.assetId} 不存在`);
        const pool = db.prepare('SELECT colorJson FROM batch_asset_pool_items WHERE batchVersionId=? AND assetId=?')
          .get(row.batchVersionId, clip.assetId) as { colorJson: string } | undefined;
        return { clipId: clip.clipId, assetId: clip.assetId, assetFingerprint: asset.contentFingerprint,
          colorSnapshot: upgradeColorSnapshot(JSON.parse(pool?.colorJson ?? '{"lutId":null}')) };
      }),
    };
  }

  return {
    outputVersionId: row.outputVersionId,
    editRevision,
    adapterVersion: BATCH_FULL_RENDER_ADAPTER_VERSION,
    ...(formula ? { formula } : {}),
    ...(parsePackagingConfig(arrangement.packaging).enabled ? { packaging: parsePackagingConfig(arrangement.packaging) } : {}),
    ...(arrangement.audio ? { audio: arrangement.audio } : {}),
    ...(arrangement.preserveGaps === true ? { preserveGaps: true } : {}),
    preset,
    outputWidth: outputSize.width,
    outputHeight: outputSize.height,
    coverContractHash,
    clips,
    narration,
    subtitles,
    music,
  };
}

export function resolveFullRenderContractHash(
  db: Database.Database,
  outputVersionId: string,
): string {
  return computeFullRenderContractHash(resolveFullRenderContract(db, outputVersionId));
}
