import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { buildLocalPointCues } from '../../media-core/packaging-cues.ts';
import { buildPackagingVars, loadProjectPackagingData, parsePackagingConfig } from '../../media-core/packaging-vars.ts';
import { FINAL_EDIT_INTRO_DURATION_US } from '../../media-core/render-contract.ts';
import type { FormulaGenerationRequest } from './generation.ts';
import { parseFormulaProductionSettings } from './production-settings.ts';
import type { FormulaTimelineResult } from './timeline.ts';

export interface FormulaPresentationLocks { packaging: boolean; cover: boolean }

export function readFormulaPresentationLocks(value: unknown, legacyEditRevision = 0): FormulaPresentationLocks {
  if (value === undefined) return { packaging: legacyEditRevision > 0, cover: legacyEditRevision > 0 };
  if (!value || typeof value !== 'object' || !('packaging' in value) || !('cover' in value)
    || typeof value.packaging !== 'boolean' || typeof value.cover !== 'boolean') {
    throw new BatchDomainError('invalid_input', '包装与封面的锁定设置无效');
  }
  return { packaging: value.packaging, cover: value.cover };
}

/** Older/minimal project schemas may not have optional product copy. Never read it again during execution. */
export function captureFormulaPresentationProject(db: Database.Database, projectId: string) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('projects') WHERE name IN ('productName','sellingPointsJson')").all();
  return columns.length === 2 ? loadProjectPackagingData(db, projectId) : {};
}

function choose(request: Pick<FormulaGenerationRequest, 'seed'>, planId: string, kind: string, ids: string[]): string {
  if (!ids.length) throw new BatchDomainError('conflict', '已冻结的包装或封面候选为空，请重新核对制作设置');
  const index = createHash('sha256').update(JSON.stringify(['formula-presentation/1', request.seed, planId, kind]))
    .digest().readUInt32BE(0) % ids.length;
  return ids[index];
}

/** Explicit redraw. The caller owns the current-output transaction and edit-revision check. */
export function reassignFormulaPresentation(db: Database.Database, projectId: string, batchId: string,
  planId: string, outputVersionId: string, arrangement: Record<string, unknown>): boolean {
  const locks = readFormulaPresentationLocks(arrangement.presentationLocks, Number(arrangement.editRevision ?? 0));
  if (locks.packaging && locks.cover) return false;
  const row = db.prepare(`SELECT r.seed,r.inputJson FROM batch_formula_output_versions v
    JOIN batch_formula_execution_stages s ON s.id=v.timelineStageId
    JOIN batch_formula_generation_requests r ON r.id=s.requestId
    WHERE v.outputVersionId=? AND s.planId=? AND r.projectId=? AND r.batchId=?`)
    .get(outputVersionId, planId, projectId, batchId) as { seed: string; inputJson: string } | undefined;
  if (!row) throw new BatchDomainError('conflict', '缺少这条成片的原制作设置，不能重新分配');
  const input = JSON.parse(row.inputJson) as FormulaGenerationRequest['input'];
  const production = parseFormulaProductionSettings(input.settings.settings.production);
  const packaging = parsePackagingConfig(arrangement.packaging);
  const cover = structuredClone(arrangement.cover ?? {}) as Record<string, unknown>;
  const presentation = { ...(arrangement.formulaPresentation as Record<string, unknown> ?? {}) };
  const before = JSON.stringify([packaging, cover]);
  const revision = Number(arrangement.editRevision ?? 0) + 1;
  const pick = (kind: string, ids: string[], current: unknown) =>
    choose(row, planId, `${kind}:reassign:${revision}`, ids.length > 1 ? ids.filter(id => id !== current) : ids);
  if (!locks.packaging) {
    const templateId = production.packaging.mode === 'none' ? null : pick('packaging', production.packaging.templateIds, packaging.template);
    packaging.enabled = templateId !== null;
    if (templateId) packaging.template = parsePackagingConfig({ enabled: true, template: templateId }).template;
    presentation.templateId = templateId;
  }
  if (!locks.cover) {
    // Undo and manual edits can change the actual cover independently of the original allocation metadata.
    const currentTitle = cover.title as Record<string, unknown> | undefined;
    const currentPreset = input.productionResources.covers.find(item => {
      const style = item.preset.stylesByPreset[production.outputPreset];
      return style && isDeepStrictEqual(style.framing, cover.framing)
        && isDeepStrictEqual({ primary: style.primary, secondary: style.secondary }, currentTitle?.styles);
    });
    const presetId = production.cover.mode === 'default' ? null : pick('cover', production.cover.presetIds, currentPreset?.id);
    const preset = presetId ? input.productionResources.covers.find(item => item.id === presetId) : null;
    const style = preset?.preset.stylesByPreset[production.outputPreset];
    if (presetId && !style) throw new BatchDomainError('conflict', '原制作设置的封面预设缺失或不支持当前画幅');
    const title = { ...(cover.title as Record<string, unknown> ?? {}) };
    if (style) {
      cover.framing = structuredClone(style.framing);
      title.styles = { primary: structuredClone(style.primary), secondary: structuredClone(style.secondary) };
    } else {
      delete cover.framing;
      delete title.styles;
    }
    if (Object.keys(title).length) cover.title = title;
    else delete cover.title;
    presentation.presetId = presetId;
    presentation.presetName = preset?.name ?? null;
  }
  if (before === JSON.stringify([packaging, cover])) return false;
  arrangement.packaging = packaging;
  arrangement.cover = cover;
  arrangement.presentationLocks = locks;
  arrangement.formulaPresentation = presentation;
  return true;
}

/** Materialize once, after real audio placement. Reads only the frozen request and this output's timeline. */
export function initialFormulaPresentation(request: FormulaGenerationRequest, planId: string, timelineStageId: string,
  timeline: Extract<FormulaTimelineResult, { status: 'planned' }>) {
  const production = parseFormulaProductionSettings(request.input.settings.settings.production);
  if (!request.outputs.some(output => output.planId === planId)) throw new BatchDomainError('conflict', '包装成片不属于这次制作请求');
  const templateId = production.packaging.mode === 'none' ? null : choose(request, planId, 'packaging', production.packaging.templateIds);
  const presetId = production.cover.mode === 'default' ? null : choose(request, planId, 'cover', production.cover.presetIds);
  const preset = presetId ? request.input.productionResources.covers.find(item => item.id === presetId) : null;
  if (presetId && !preset) throw new BatchDomainError('conflict', '已冻结的封面预设缺失，请重新核对制作设置');
  const style = preset?.preset.stylesByPreset[production.outputPreset];
  if (preset && !style) throw new BatchDomainError('conflict', '已冻结的封面预设不支持当前画幅');
  const words = timeline.words.map(({ text, startUs, endUs }) => ({ text, startUs, endUs }));
  const project = request.input.presentationProject ?? {};
  const vars = buildPackagingVars({ project, subtitleCues: words.map(word => ({ ...word, textSource: 'script' })) });
  const cues = buildLocalPointCues({ narrationText: words.map(word => word.text).join('，'), words, subtitleCues: words,
    sellingPoints: project.sellingPoints ?? [], totalSec: (timeline.duration.bodyDurationUs + FINAL_EDIT_INTRO_DURATION_US) / 1e6,
    coverSec: FINAL_EDIT_INTRO_DURATION_US / 1e6, narrationPlaybackRate: 1 });
  const explicitCues = (timeline.onScreen ?? []).map(cue => ({
    id: `p_${createHash('sha256').update(JSON.stringify(['formula-text/1', timeline.mappingStageId, cue.blockId])).digest('hex').slice(0, 22)}`,
    text: cue.displayText, startSec: (cue.startUs + FINAL_EDIT_INTRO_DURATION_US) / 1e6,
    endSec: (cue.endUs + FINAL_EDIT_INTRO_DURATION_US) / 1e6,
  }));
  const first = timeline.duration.clips[0];
  if (!first) throw new BatchDomainError('conflict', '没有可用于封面的已排片画面');
  return {
    presentationLocks: { packaging: false, cover: false },
    formulaPresentation: { version: 1, packagingMode: production.packaging.mode, templateId,
      coverMode: production.cover.mode, presetId, presetName: preset?.name ?? null },
    cover: { assetId: first.assetId, timeUs: first.sourceInUs,
      ...(style ? { framing: structuredClone(style.framing), title: { primary: vars.title, secondary: vars.subtitle,
        styles: { primary: structuredClone(style.primary), secondary: structuredClone(style.secondary) } } } : {}) },
    packaging: parsePackagingConfig({ enabled: templateId !== null, template: templateId ?? undefined,
      varsOverrides: vars, pointCuesMode: explicitCues.length ? 'timed' : cues.mode, pointCuesEdited: false,
      pointCues: explicitCues.length ? explicitCues : cues.pointCues.map((cue, index) => ({ ...cue,
        id: `p_${createHash('sha256').update(JSON.stringify(['formula-cue/1', planId, timelineStageId, index, cue])).digest('hex').slice(0, 24)}` })),
    }),
  };
}
