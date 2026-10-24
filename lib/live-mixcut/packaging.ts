import { extractSellingPointsWithLLM } from '../media-core/packaging-extraction.ts';
import { splitCoverTitle } from '../media-core/cover-domain.ts';
import type Database from 'better-sqlite3';
import { buildPointCues, buildLocalPointCues, generatePointCueId, parseStoredWordTimings, extractHeuristicPoints, dedupeCandidates } from '../media-core/packaging-cues.ts';
import { buildPackagingVars, loadProjectPackagingData, parsePackagingConfig, type FinalEditPackagingConfig } from '../media-core/packaging-vars.ts';
import { FINAL_EDIT_INTRO_DURATION_US } from '../media-core/render-contract.ts';
import type { BatchOutputClipEditView } from './output-arrangement.ts';
import { BatchDomainError } from './errors.ts';
import { safeFontFilename, userFontDir } from '../media-core/packaging-font.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { FormulaGenerationRequest } from './formula/generation.ts';

type PackagingSource = Pick<BatchOutputClipEditView, 'planId' | 'coverTitle' | 'coverTitleOverride' | 'visualDurationUs'> & {
  subtitleCues: Array<{ text: string; startUs: number; endUs: number }>;
  narration: { durationUs: number | null };
  audioPlan?: BatchOutputClipEditView['audioPlan'];
};

function batchNarrationPackaging(db: Database.Database, view: PackagingSource) {
  if (view.audioPlan) return { words: view.subtitleCues,
    points: extractHeuristicPoints(view.subtitleCues.map(cue => cue.text).join('，')) };
  const row = db.prepare(`SELECT n.narrationJson FROM live_mixcut_output_plans p
    JOIN live_mixcut_script_narrations n ON n.scriptSnapshotId=p.scriptSnapshotId AND n.batchVersionId=p.batchVersionId WHERE p.id=?`).get(view.planId) as { narrationJson: string } | undefined;
  let stored: { wordTimings?: unknown; packagingPoints?: unknown } = {};
  try { stored = JSON.parse(row?.narrationJson ?? '{}') ?? {}; } catch { /* Legacy snapshots use subtitles. */ }
  return {
    words: parseStoredWordTimings(stored.wordTimings).words,
    points: Array.isArray(stored.packagingPoints) ? stored.packagingPoints.filter((value): value is string => typeof value === 'string') : extractHeuristicPoints(view.subtitleCues.map(cue => cue.text).join('，')),
  };
}

function batchPackagingProject(db: Database.Database, projectId: string, view: PackagingSource) {
  if (!view.audioPlan) return loadProjectPackagingData(db, projectId);
  const row = db.prepare(`SELECT g.inputJson FROM live_mixcut_formula_generation_outputs o
    JOIN live_mixcut_formula_generation_requests g ON g.id=o.requestId WHERE o.planId=? AND g.projectId=?`)
    .get(view.planId, projectId) as { inputJson: string } | undefined;
  // Historical requests have no product copy snapshot; never fill them from today's project.
  const input: FormulaGenerationRequest['input'] | undefined = row ? JSON.parse(row.inputJson) : undefined;
  return input?.presentationProject ?? {};
}

export function batchPackagingDefaults(db: Database.Database, projectId: string, view: PackagingSource) {
  const project = batchPackagingProject(db, projectId, view);
  if (view.audioPlan) return buildPackagingVars({ project,
    ...(view.coverTitleOverride && view.coverTitle ? { coverTitle: view.coverTitle } : {}),
    subtitleCues: view.subtitleCues.map(cue => ({ ...cue, textSource: 'script' })) });
  const script = db.prepare(`SELECT s.title, s.coverTitleJson FROM live_mixcut_output_plans p
    JOIN live_mixcut_script_snapshots s ON s.id=p.scriptSnapshotId WHERE p.id=?`).get(view.planId) as { title: string; coverTitleJson: string } | undefined;
  let coverTitle = script ? splitCoverTitle(script.title) : undefined;
  try {
    const saved = JSON.parse(script?.coverTitleJson ?? '{}');
    if (typeof saved.primary === 'string' && typeof saved.secondary === 'string') coverTitle = saved;
  } catch { /* Old snapshots fall back to the script title. */ }
  if (view.coverTitleOverride && view.coverTitle) coverTitle = view.coverTitle;
  return buildPackagingVars({ project: { ...project, sellingPoints: project.sellingPoints?.length ? project.sellingPoints : dedupeCandidates(batchNarrationPackaging(db, view).points) }, coverTitle, subtitleCues: [] });
}

/** Explicit saves freeze defaults and timings. Preview/render never mutate a saved arrangement. */
export async function prepareBatchPackagingConfig(db: Database.Database, projectId: string, view: BatchOutputClipEditView, value: unknown, reextract = false): Promise<FinalEditPackagingConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BatchDomainError('invalid_input', '包装配置无效');
  const incoming = value as Partial<FinalEditPackagingConfig>;
  const limit = Math.max(view.visualDurationUs, view.narration.durationUs ?? 0) / 1e6 + FINAL_EDIT_INTRO_DURATION_US / 1e6;
  if (incoming.pointCues !== undefined && (!Array.isArray(incoming.pointCues) || incoming.pointCues.length > 24 || incoming.pointCues.some(cue => !cue || typeof cue.text !== 'string' || !cue.text.trim() || typeof cue.id !== 'string' || !cue.id || !Number.isFinite(cue.startSec) || !Number.isFinite(cue.endSec) || cue.startSec < FINAL_EDIT_INTRO_DURATION_US / 1e6 - 0.001 || cue.endSec <= cue.startSec || cue.endSec > limit + 0.001))) throw new BatchDomainError('invalid_input', '卖点时间必须位于正片范围内，结束时间须晚于开始时间');
  if (incoming.pointCues && new Set(incoming.pointCues.map(cue => cue.id)).size !== incoming.pointCues.length) throw new BatchDomainError('invalid_input', '卖点标识重复');
  const config = parsePackagingConfig(value);
  for (const slot of [config.titleFont, config.subtitleFont, config.pointFont]) {
    if (slot && (!safeFontFilename(slot.file) || !fs.existsSync(path.join(userFontDir(), slot.file)))) throw new BatchDomainError('invalid_input', '所选包装字体不存在，请重新选择');
  }
  config.varsOverrides = { ...batchPackagingDefaults(db, projectId, view), ...config.varsOverrides };
  if (config.enabled && (reextract || !config.pointCues)) {
    const built = await buildPointCues({
      extractPoints: text => extractSellingPointsWithLLM(text),
      narrationText: view.subtitleCues.map(cue => cue.text).join('，'), words: batchNarrationPackaging(db, view).words, subtitleCues: view.subtitleCues,
      sellingPoints: batchPackagingProject(db, projectId, view).sellingPoints ?? [],
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
export function initialBatchPackagingConfig(db: Database.Database, projectId: string, view: PackagingSource, previous?: unknown): FinalEditPackagingConfig {
  const config = previous ? parsePackagingConfig(previous) : parsePackagingConfig({ enabled: true });
  const explicitlyEmpty = config.pointCuesEdited && config.pointCues?.length === 0;
  const narration = batchNarrationPackaging(db, view);
  const projectPoints = loadProjectPackagingData(db, projectId).sellingPoints ?? [];
  const built = buildLocalPointCues({ narrationText: view.subtitleCues.map(cue => cue.text).join('，'),
    words: narration.words, subtitleCues: view.subtitleCues, sellingPoints: projectPoints.length ? projectPoints : narration.points,
    totalSec: (Math.max(view.visualDurationUs, view.narration.durationUs ?? 0) + FINAL_EDIT_INTRO_DURATION_US) / 1e6,
    coverSec: FINAL_EDIT_INTRO_DURATION_US / 1e6, narrationPlaybackRate: 1 });
  return { ...config, varsOverrides: { ...batchPackagingDefaults(db, projectId, view), ...config.varsOverrides },
    pointCues: explicitlyEmpty ? [] : built.pointCues.map(cue => ({ ...cue, id: generatePointCueId() })), pointCuesMode: explicitlyEmpty ? 'none' : built.mode,
    pointCuesEdited: explicitlyEmpty === true, layouts: Object.fromEntries(Object.entries(config.layouts ?? {}).map(([key, layout]) => [key, { cover: layout.cover }])) };
}
