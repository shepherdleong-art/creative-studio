import { extractSellingPointsWithLLM } from '../media-core/packaging-extraction.ts';
import { splitCoverTitle } from '../media-core/cover-domain.ts';
import type Database from 'better-sqlite3';
import { buildPointCues, buildLocalPointCues, generatePointCueId, parseStoredWordTimings, extractHeuristicPoints, dedupeCandidates } from '../media-core/packaging-cues.ts';
import { buildPackagingVars, loadProjectPackagingData, parsePackagingConfig, type FinalEditPackagingConfig } from '../media-core/packaging-vars.ts';
import { resolveLayoutRuntimeBundleVersion, resolvePointCuesLayoutVersion } from '../media-core/packaging-auto-layout.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_DURATION_US } from '../media-core/render-contract.ts';
import { PackagingStickerError, validatePackagingStickerDefaults, validatePackagingStickers } from '../media-core/packaging-stickers.ts';
import { resolveInitialPackagingStickers, type resolvePackagingAutoLayout } from '../media-core/packaging-auto-layout-service.ts';
import type { BatchOutputClipEditView } from './output-arrangement.ts';
import { BatchDomainError } from './errors.ts';
import { resolveBatchOutputSize } from './output-presets.ts';
import { safeFontFilename, userFontDir } from '../media-core/packaging-font.ts';
import fs from 'node:fs';
import path from 'node:path';

type PackagingSource = Pick<BatchOutputClipEditView, 'planId' | 'coverTitle' | 'coverTitleOverride' | 'visualDurationUs'> & {
  subtitleCues: Array<{ text: string; startUs: number; endUs: number }>;
  narration: { durationUs: number | null };
};

function batchNarrationPackaging(db: Database.Database, view: PackagingSource) {
  const row = db.prepare(`SELECT n.narrationJson FROM batch_output_plans p
    JOIN batch_script_narrations n ON n.scriptSnapshotId=p.scriptSnapshotId AND n.batchVersionId=p.batchVersionId WHERE p.id=?`).get(view.planId) as { narrationJson: string } | undefined;
  let stored: { wordTimings?: unknown; packagingPoints?: unknown } = {};
  try { stored = JSON.parse(row?.narrationJson ?? '{}') ?? {}; } catch { /* Legacy snapshots use subtitles. */ }
  return {
    words: parseStoredWordTimings(stored.wordTimings).words,
    points: Array.isArray(stored.packagingPoints) ? stored.packagingPoints.filter((value): value is string => typeof value === 'string') : extractHeuristicPoints(view.subtitleCues.map(cue => cue.text).join('，')),
  };
}

export function batchPackagingDefaults(db: Database.Database, projectId: string, view: PackagingSource) {
  const project = loadProjectPackagingData(db, projectId);
  const script = db.prepare(`SELECT s.title, s.coverTitleJson FROM batch_output_plans p
    JOIN batch_script_snapshots s ON s.id=p.scriptSnapshotId WHERE p.id=?`).get(view.planId) as { title: string; coverTitleJson: string } | undefined;
  let coverTitle = script ? splitCoverTitle(script.title) : undefined;
  try {
    const saved = JSON.parse(script?.coverTitleJson ?? '{}');
    if (typeof saved.primary === 'string' && typeof saved.secondary === 'string') coverTitle = saved;
  } catch { /* Old snapshots fall back to the script title. */ }
  if (view.coverTitleOverride && view.coverTitle) coverTitle = view.coverTitle;
  return buildPackagingVars({ project: { ...project, sellingPoints: project.sellingPoints?.length ? project.sellingPoints : dedupeCandidates(batchNarrationPackaging(db, view).points) }, coverTitle, subtitleCues: [] });
}

/** Validate raw writes before the legacy reader can discard malformed sticker fields. */
export function validateBatchPackagingStickers(value: unknown, bodyFrames: number): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BatchDomainError('invalid_input', '包装配置必须是对象');
  const incoming = value as Partial<FinalEditPackagingConfig>;
  try {
    if (incoming.stickers !== undefined) validatePackagingStickers(incoming.stickers, bodyFrames);
    if (incoming.stickerDefaults !== undefined) validatePackagingStickerDefaults(incoming.stickerDefaults);
  } catch (error) {
    if (error instanceof PackagingStickerError) throw new BatchDomainError('invalid_input', error.message);
    throw error;
  }
}

/** Explicit saves freeze defaults and timings. Preview/render never mutate a saved arrangement. */
export async function prepareBatchPackagingConfig(db: Database.Database, projectId: string, view: BatchOutputClipEditView, value: unknown, reextract = false): Promise<FinalEditPackagingConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BatchDomainError('invalid_input', '包装配置无效');
  const incoming = value as Partial<FinalEditPackagingConfig>;
  const limit = Math.max(view.visualDurationUs, view.narration.durationUs ?? 0) / 1e6 + FINAL_EDIT_INTRO_DURATION_US / 1e6;
  if (incoming.pointCues !== undefined && (!Array.isArray(incoming.pointCues) || incoming.pointCues.length > 24 || incoming.pointCues.some(cue => !cue || typeof cue.text !== 'string' || !cue.text.trim() || typeof cue.id !== 'string' || !cue.id || !Number.isFinite(cue.startSec) || !Number.isFinite(cue.endSec) || cue.startSec < FINAL_EDIT_INTRO_DURATION_US / 1e6 - 0.001 || cue.endSec <= cue.startSec || cue.endSec > limit + 0.001))) throw new BatchDomainError('invalid_input', '卖点时间必须位于正片范围内，结束时间须晚于开始时间');
  if (incoming.pointCues && new Set(incoming.pointCues.map(cue => cue.id)).size !== incoming.pointCues.length) throw new BatchDomainError('invalid_input', '卖点标识重复');
  const bodyFrames = Math.floor(Math.max(view.visualDurationUs, view.narration.durationUs ?? 0) / 1e6 * FINAL_EDIT_FPS + 1e-6);
  // 原始请求先严格校验：parsePackagingConfig 会兼容清洗，不能靠清洗结果冒充保存成功。
  validateBatchPackagingStickers(value, bodyFrames);
  const current = view.packaging ?? parsePackagingConfig(null);
  const incomingConfig = parsePackagingConfig(value);
  const pointCuesLayoutVersion = resolvePointCuesLayoutVersion(
    current.pointCuesLayoutVersion,
    reextract ? 'explicit-reextract' : 'automatic-rebuild',
  );
  const config: FinalEditPackagingConfig = {
    ...incomingConfig,
    ...(pointCuesLayoutVersion !== undefined ? { pointCuesLayoutVersion } : {}),
    layoutRuntimeBundleVersion: resolveLayoutRuntimeBundleVersion({
      previous: current.layoutRuntimeBundleVersion,
      pointCuesLayoutVersion,
      stickers: incomingConfig.stickers,
    }),
    // 普通保存不能回填客户端携带的旧解析结果；只有布局命令可写 resolved。
    layoutResolution: current.layoutResolution ? { ...current.layoutResolution, status: 'stale' as const } : undefined,
  };
  for (const slot of [config.titleFont, config.subtitleFont, config.pointFont]) {
    if (slot && (!safeFontFilename(slot.file) || !fs.existsSync(path.join(userFontDir(), slot.file)))) throw new BatchDomainError('invalid_input', '所选包装字体不存在，请重新选择');
  }
  config.varsOverrides = { ...batchPackagingDefaults(db, projectId, view), ...config.varsOverrides };
  if (config.enabled && (reextract || !config.pointCues)) {
    const built = await buildPointCues({
      extractPoints: text => extractSellingPointsWithLLM(text, undefined, undefined, {
        taskId: view.planId,
        scope: { resourceType: 'project', resourceId: projectId },
      }),
      narrationText: view.subtitleCues.map(cue => cue.text).join('，'), words: batchNarrationPackaging(db, view).words, subtitleCues: view.subtitleCues,
      sellingPoints: loadProjectPackagingData(db, projectId).sellingPoints ?? [],
      totalSec: (Math.max(view.visualDurationUs, view.narration.durationUs ?? 0) + FINAL_EDIT_INTRO_DURATION_US) / 1e6,
      coverSec: FINAL_EDIT_INTRO_DURATION_US / 1e6, narrationPlaybackRate: 1,
    });
    config.pointCues = built.pointCues.map(cue => ({ ...cue, id: generatePointCueId() }));
    config.pointCuesMode = built.mode;
    config.pointCuesEdited = false;
    config.layouts = Object.fromEntries(Object.entries(config.layouts ?? {}).map(([key, layout]) => [key, { cover: layout.cover }]));
  }
  return config;
}

/** Freeze packaging in new output versions; historical arrangements remain unchanged. */
export function initialBatchPackagingConfig(
  db: Database.Database,
  projectId: string,
  view: PackagingSource,
  previous?: unknown,
): FinalEditPackagingConfig {
  const config = previous ? parsePackagingConfig(previous) : parsePackagingConfig({ enabled: true });
  const explicitlyEmpty = config.pointCuesEdited && config.pointCues?.length === 0;
  const narration = batchNarrationPackaging(db, view);
  const projectPoints = loadProjectPackagingData(db, projectId).sellingPoints ?? [];
  const bodyDurationUs = Math.max(view.visualDurationUs, view.narration.durationUs ?? 0);
  const built = buildLocalPointCues({ narrationText: view.subtitleCues.map(cue => cue.text).join('，'),
    words: narration.words, subtitleCues: view.subtitleCues, sellingPoints: projectPoints.length ? projectPoints : narration.points,
    totalSec: (bodyDurationUs + FINAL_EDIT_INTRO_DURATION_US) / 1e6,
    coverSec: FINAL_EDIT_INTRO_DURATION_US / 1e6, narrationPlaybackRate: 1 });
  const pointCuesLayoutVersion = resolvePointCuesLayoutVersion(
    config.pointCuesLayoutVersion,
    previous ? 'derived-version' : 'initial',
  );
  return { ...config, varsOverrides: { ...batchPackagingDefaults(db, projectId, view), ...config.varsOverrides },
    pointCues: explicitlyEmpty ? [] : built.pointCues.map(cue => ({ ...cue, id: generatePointCueId() })), pointCuesMode: explicitlyEmpty ? 'none' : built.mode,
    pointCuesLayoutVersion,
    layoutRuntimeBundleVersion: resolveLayoutRuntimeBundleVersion({ previous: config.layoutRuntimeBundleVersion, pointCuesLayoutVersion, stickers: config.stickers }),
    layoutResolution: config.layoutResolution ? { ...config.layoutResolution, status: 'stale' as const } : undefined,
    pointCuesEdited: explicitlyEmpty === true, layouts: Object.fromEntries(Object.entries(config.layouts ?? {}).map(([key, layout]) => [key, { cover: layout.cover }])) };
}

export function batchPackagingLayoutInput(arrangement: Record<string, unknown>, config: FinalEditPackagingConfig) {
  const narration = arrangement.narration as { productionReady?: boolean; durationUs?: number } | undefined;
  // 正式口播决定导出正文时长，和整片渲染采用同一口径。
  const durationUs = narration?.productionReady === true ? narration.durationUs
    : Math.max(0, ...(Array.isArray(arrangement.clips)
      ? arrangement.clips.map(clip => Number(clip?.timelineEndUs) || 0) : []));
  if (typeof durationUs !== 'number' || !Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new BatchDomainError('invalid_input', '自动布局的成片时长无效');
  }
  const size = resolveBatchOutputSize(arrangement.preset);
  const coverSec = FINAL_EDIT_INTRO_DURATION_US / 1e6;
  return {
    config, vars: buildPackagingVars({ subtitleCues: [], overrides: config.varsOverrides }),
    totalSec: durationUs / 1e6 + coverSec, coverSec,
    outputWidth: size.width, outputHeight: size.height,
  };
}

/** 封面任务在分配提交后求解首次贴纸。候选、规范几何和修订一起写入当前版本。 */
export async function initializeBatchOutputStickers(options: {
  db: Database.Database; outputVersionId: string; signal?: AbortSignal; resolveLayout?: typeof resolvePackagingAutoLayout;
}): Promise<boolean> {
  const { db, outputVersionId, signal } = options;
  const currentVersion = `EXISTS (SELECT 1 FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    WHERE p.id = batch_output_versions.planId AND p.currentVersionId = batch_output_versions.id
      AND v.inputState = 'frozen' AND b.currentVersionId = v.id AND b.controlState <> 'stopped' AND b.deletedAt IS NULL)`;
  const row = db.prepare(`SELECT arrangementJson FROM batch_output_versions
    WHERE id = ? AND versionNumber = 1 AND ${currentVersion}`).get(outputVersionId) as { arrangementJson: string } | undefined;
  if (!row) return false;
  const arrangement = JSON.parse(row.arrangementJson) as Record<string, unknown>;
  if ((arrangement.editRevision ?? 0) !== 0 || arrangement.review != null) return false;
  const config = parsePackagingConfig(arrangement.packaging);
  if (!config.enabled || config.stickers !== undefined) return false;
  const layoutInput = batchPackagingLayoutInput(arrangement, config);
  const resolved = await resolveInitialPackagingStickers({
    ...layoutInput, signal,
    bodyFrames: Math.floor((layoutInput.totalSec - layoutInput.coverSec) * FINAL_EDIT_FPS + 1e-6),
  }, options.resolveLayout);
  signal?.throwIfAborted();
  if (!resolved) return false;
  // 审片可能已经补齐旧配置的派生布局，仍可采用同输入下解出的首次贴纸。
  return db.prepare(`UPDATE batch_output_versions
    SET arrangementJson = json_set(arrangementJson, '$.packaging', json(?), '$.editRevision', 1)
    WHERE id = ? AND ${currentVersion}
      AND json_remove(arrangementJson, '$.packaging.layoutResolution') = json_remove(?, '$.packaging.layoutResolution')`)
    .run(JSON.stringify(resolved), outputVersionId, row.arrangementJson).changes === 1;
}
