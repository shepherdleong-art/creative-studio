import { parsePackagingConfig } from '../media-core/packaging-vars.ts';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { upgradeColorSnapshot, type ColorSnapshotV1 } from './color-pipeline.ts';
import {
  loadFrozenCoverTitleConfig,
  parseFrozenCoverTitleRow,
  resolveBatchCoverTitleOverride,
  type FrozenCoverTitleRow,
} from './cover-title.ts';
import type { CoverFraming, TextStyle } from '../media-core/cover-types.ts';
import { BATCH_OUTPUT_PRESETS, type BatchOutputPreset } from './output-presets.ts';

export const BATCH_COVER_RENDERER_VERSION = 'batch-cover-v1';
export const BATCH_FULL_RENDER_ADAPTER_VERSION = 'batch-render-v3';

/** 契约解析所需的输出/计划/批次版本联合行。 */
export interface CoverContractOutputVersion {
  outputVersionId: string;
  planId: string;
  arrangementJson: string;
  /** 同次请求内已解析的 arrangement;存在时不再重复 JSON.parse。 */
  arrangement?: Record<string, unknown>;
  batchVersionId: string;
  planSeq: number;
  defaultsJson: string;
}

/**
 * 同次请求内的只读预加载上下文。工作区按批次集中取数后传入,
 * 契约计算逻辑与逐条查询时完全一致;不传时行为不变。
 * 各映射按 key 命中才生效(包括值为 null 的命中),缺 key 一律回落原逐条查询。
 */
export interface CoverContractPreload {
  /** outputVersionId → 版本 + 计划 + 批次版本行 */
  outputVersions?: ReadonlyMap<string, CoverContractOutputVersion>;
  /** assetId → contentFingerprint(建议覆盖所有会被引用的素材;缺 key 回落原查询)。 */
  assetFingerprints?: ReadonlyMap<string, string>;
  /** `${batchVersionId}\u0000${assetId}` → 冻结色彩快照 JSON(池内行,含 null;缺 key 回落原查询)。 */
  poolColors?: ReadonlyMap<string, string | null>;
  /** assetId → 最近一条素材分析的 colorJson;命中 null 表示没有分析行。 */
  analysisColors?: ReadonlyMap<string, string | null>;
  /** true 表示批次预加载遇到旧库缺少 analysis colorJson 列,缺池色必须按原 fail-closed 处理。 */
  analysisColorsUnavailable?: boolean;
  /** planId → 冻结封面标题原始行(可含 null 表示无冻结配置;缺 key 回落原查询)。 */
  frozenTitleRows?: ReadonlyMap<string, FrozenCoverTitleRow | null>;
  /** 同次请求内复用封面契约哈希缓存;仅未显式传 frozenArrangementJson 时使用。 */
  coverContractHashes?: Map<string, string>;
}

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
  /** 可选:工作区按批次预加载的行;缺项时回落到原查询,行为不变。 */
  preload?: CoverContractPreload,
): CoverContractInput {
  let row = preload?.outputVersions?.get(outputVersionId);
  if (!row) {
    row = db.prepare(`
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
    `).get(outputVersionId) as CoverContractOutputVersion | undefined;
  }
  if (!row) throw new Error(`outputVersion ${outputVersionId} 不存在`);

  let arrangement: Record<string, unknown>;
  if (frozenArrangementJson !== undefined) {
    try {
      arrangement = JSON.parse(frozenArrangementJson) as Record<string, unknown>;
    } catch {
      throw new Error('arrangementJson 无法解析');
    }
  } else if (row.arrangement !== undefined) {
    if (row.arrangement === null || typeof row.arrangement !== 'object' || Array.isArray(row.arrangement)) {
      throw new Error('arrangementJson 无法解析');
    }
    arrangement = row.arrangement;
  } else {
    try {
      arrangement = JSON.parse(row.arrangementJson) as Record<string, unknown>;
    } catch {
      throw new Error('arrangementJson 无法解析');
    }
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

  let assetFingerprint: string;
  if (preload?.assetFingerprints?.has(assetId)) {
    assetFingerprint = preload.assetFingerprints.get(assetId) as string;
  } else {
    const asset = db.prepare(`SELECT contentFingerprint FROM batch_assets WHERE id = ?`).get(assetId) as { contentFingerprint: string } | undefined;
    if (!asset) throw new Error(`素材 ${assetId} 不存在`);
    assetFingerprint = asset.contentFingerprint;
  }

  const poolColorKey = `${row.batchVersionId}\u0000${assetId}`;
  let colorJsonStr: string | null | undefined;
  if (preload?.poolColors?.has(poolColorKey)) {
    colorJsonStr = preload.poolColors.get(poolColorKey) ?? null;
  } else {
    const poolItem = db.prepare(`SELECT colorJson FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?`).get(row.batchVersionId, assetId) as { colorJson: string } | undefined;
    colorJsonStr = poolItem?.colorJson;
  }
  if (!colorJsonStr) {
    if (preload?.analysisColors) {
      if (preload.analysisColors.has(assetId)) {
        // 预加载覆盖到的素材:命中 null 表示没有分析行,与原逐卡查询一致回落默认。
        colorJsonStr = preload.analysisColors.get(assetId) ?? '{"lutId":null}';
      } else {
        // 预加载未覆盖该素材:回落逐卡查询,保持单卡失败语义。
        const analysis = db.prepare(`SELECT colorJson FROM batch_asset_analysis WHERE assetId = ? ORDER BY createdAt DESC LIMIT 1`).get(assetId) as { colorJson: string } | undefined;
        colorJsonStr = analysis?.colorJson ?? '{"lutId":null}';
      }
    } else if (preload?.analysisColorsUnavailable) {
      // 预加载不可用(例如旧库没有 analysis colorJson 列):保持原逐卡查询失败
      // 时的 fail-closed 语义,但不再为每张卡发起一次必败的 SQL。
      throw new Error(`素材 ${assetId} 缺少可用色彩快照`);
    } else {
      // 池内没有色彩快照时回落到最近一条素材分析;该查询本身失败时保持
      // 原来的 fail-closed 语义(契约不可解析),不在这里吞错。
      const analysis = db.prepare(`SELECT colorJson FROM batch_asset_analysis WHERE assetId = ? ORDER BY createdAt DESC LIMIT 1`).get(assetId) as { colorJson: string } | undefined;
      colorJsonStr = analysis?.colorJson ?? '{"lutId":null}';
    }
  }

  const colorSnapshot = upgradeColorSnapshot(JSON.parse(colorJsonStr));
  const lutFingerprint = colorSnapshot.lutFingerprint ?? null;

  // 只有预加载确实覆盖该 plan 时才用映射(包括 null);缺 key 回落原查询。
  const frozenTitleConfig = preload?.frozenTitleRows?.has(row.planId)
    ? parseFrozenCoverTitleRow(preload.frozenTitleRows.get(row.planId))
    : loadFrozenCoverTitleConfig(db, row.planId);
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
    assetFingerprint,
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
  preload?: CoverContractPreload,
): string {
  // 冻结输入覆盖不参与请求级缓存:同一版本可能因快照不同而得出不同哈希。
  if (!frozenArrangementJson) {
    const cached = preload?.coverContractHashes?.get(outputVersionId);
    if (cached !== undefined) return cached;
  }
  const hash = computeCoverContractHash(resolveCoverContract(db, outputVersionId, frozenArrangementJson, preload));
  if (!frozenArrangementJson) preload?.coverContractHashes?.set(outputVersionId, hash);
  return hash;
}

export function resolveFullRenderContract(
  db: Database.Database,
  outputVersionId: string,
  preload?: CoverContractPreload,
): FullRenderContractInput {
  let row: { outputVersionId: string; arrangementJson: string; arrangement?: Record<string, unknown> } | undefined =
    preload?.outputVersions?.get(outputVersionId);
  if (!row) {
    row = db.prepare(`
      SELECT
        o.id AS outputVersionId,
        o.arrangementJson AS arrangementJson
      FROM batch_output_versions o
      WHERE o.id = ?
    `).get(outputVersionId) as {
      outputVersionId: string;
      arrangementJson: string;
    } | undefined;
  }
  if (!row) throw new Error(`outputVersion ${outputVersionId} 不存在`);

  let arrangement: Record<string, unknown>;
  if (row.arrangement !== undefined) {
    if (row.arrangement === null || typeof row.arrangement !== 'object' || Array.isArray(row.arrangement)) {
      throw new Error('arrangementJson 无法解析');
    }
    arrangement = row.arrangement;
  } else {
    try {
      arrangement = JSON.parse(row.arrangementJson) as Record<string, unknown>;
    } catch {
      throw new Error('arrangementJson 无法解析');
    }
  }
  const editRevision = Number.isSafeInteger(Number(arrangement.editRevision)) && Number(arrangement.editRevision) > 0
    ? Number(arrangement.editRevision)
    : 0;
  const preset = (typeof arrangement.preset === 'string' ? arrangement.preset : '3:4') as BatchOutputPreset;
  const outputSize = BATCH_OUTPUT_PRESETS[preset] ?? BATCH_OUTPUT_PRESETS['3:4'];

  // 统一走 resolveCoverContractHash:同请求内命中封面契约缓存时不再重复解析,
  // 未命中时才解析一次并写回缓存。
  const coverContractHash = resolveCoverContractHash(db, outputVersionId, undefined, preload);

  const rawClips = Array.isArray(arrangement.clips) ? arrangement.clips as Array<Record<string, unknown>> : [];
  const clips = rawClips.map((c) => ({
    clipId: String(c.clipId ?? c.id ?? c.segmentId ?? ''),
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

  return {
    outputVersionId: row.outputVersionId,
    editRevision,
    adapterVersion: BATCH_FULL_RENDER_ADAPTER_VERSION,
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
  preload?: CoverContractPreload,
): string {
  return computeFullRenderContractHash(resolveFullRenderContract(db, outputVersionId, preload));
}
