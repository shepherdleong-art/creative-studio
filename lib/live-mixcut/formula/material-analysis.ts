/**
 * 分析画面的结果按素材内容存在项目下。
 *
 * 视觉模型只看画面，给出有效片段和一句简短的画面描述；同一段素材（内容指纹相同）
 * 无论出现在哪个批次，都只分析一次。口播镜头不做画面分析：它的有效片段按原声说话起止算。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VideoContentAnalysis } from '../../media-core/adapters/video-analysis.ts';
import { getFormulaMaterialIndex } from './material-bindings.ts';
import { readFormulaInputs } from './import-store.ts';
import { isVoiceOver } from '../scheduling/text.ts';

export interface FormulaMaterialAnalysis {
  id: string;
  contentFingerprint: string;
  durationUs: number;
  usableInUs: number;
  usableOutUs: number;
  description: string;
  providerId: string;
  providerName: string;
  model: string;
  analyzedAt: string;
  analysis: VideoContentAnalysis;
}

export interface FormulaMaterialAnalysisGap {
  /** 还差分析的素材编号；按编号顺序。 */
  missingCodes: string[];
  /** 每个编号还差几段文件。 */
  missingByCode: Record<string, number>;
  /** 还差几段，合计。 */
  missingSources: number;
}

interface AnalysisRow {
  id: string; contentFingerprint: string; durationUs: number; usableInUs: number; usableOutUs: number;
  description: string; providerId: string; providerName: string; model: string; analyzedAt: string; analysisJson: string;
}

function toAnalysis(row: AnalysisRow): FormulaMaterialAnalysis {
  return {
    id: row.id, contentFingerprint: row.contentFingerprint, durationUs: row.durationUs,
    usableInUs: row.usableInUs, usableOutUs: row.usableOutUs, description: row.description,
    providerId: row.providerId, providerName: row.providerName, model: row.model, analyzedAt: row.analyzedAt,
    analysis: JSON.parse(row.analysisJson) as VideoContentAnalysis,
  };
}

/**
 * 有效片段：取画质分最高的一段；分数一样时取更长的一段。
 * 模型没给可用区间时退回整段素材。
 */
export function pickFormulaUsableRange(analysis: VideoContentAnalysis): { inUs: number; outUs: number } {
  let best: VideoContentAnalysis['usableRanges'][number] | null = null;
  for (const range of analysis.usableRanges) {
    if (!(range.endUs > range.startUs)) continue;
    if (!best || range.qualityScore > best.qualityScore
      || (range.qualityScore === best.qualityScore && range.endUs - range.startUs > best.endUs - best.startUs)) best = range;
  }
  if (best) return { inUs: Math.round(best.startUs), outUs: Math.round(best.endUs) };
  const endUs = analysis.usableRanges.reduce((max, range) => Math.max(max, range.endUs), 0);
  return { inUs: 0, outUs: Math.round(endUs) };
}

/** 画面描述：优先用整体总结，没有就用各段的描述拼起来。 */
export function formulaAnalysisDescription(analysis: VideoContentAnalysis): string {
  return (analysis.summary || analysis.scenes.map(scene => scene.description).filter(Boolean).join('；')).slice(0, 400);
}

export function listFormulaMaterialAnalyses(db: Database.Database, projectId: string): Map<string, FormulaMaterialAnalysis> {
  const rows = db.prepare('SELECT * FROM live_mixcut_formula_material_analysis WHERE projectId=? ORDER BY analyzedAt, rowid')
    .all(projectId) as AnalysisRow[];
  return new Map(rows.map(row => [row.contentFingerprint, toAnalysis(row)]));
}

export function readFormulaMaterialAnalysis(db: Database.Database, projectId: string, contentFingerprint: string): FormulaMaterialAnalysis | null {
  const row = db.prepare('SELECT * FROM live_mixcut_formula_material_analysis WHERE projectId=? AND contentFingerprint=?')
    .get(projectId, contentFingerprint) as AnalysisRow | undefined;
  return row ? toAnalysis(row) : null;
}

/**
 * 保存一段素材的画面分析。内容相同就只留第一份：同样的画面分析两次没有意义，
 * 而且并发调用时后到的结果不该覆盖先到的。
 */
export function saveFormulaMaterialAnalysis(db: Database.Database, projectId: string, input: {
  contentFingerprint: string; analysis: VideoContentAnalysis;
  provider: { id: string; name: string; model: string };
}): FormulaMaterialAnalysis {
  const range = pickFormulaUsableRange(input.analysis);
  const durationUs = input.analysis.usableRanges.reduce((max, item) => Math.max(max, item.endUs), 0);
  db.prepare(`INSERT INTO live_mixcut_formula_material_analysis
    (id,projectId,contentFingerprint,durationUs,usableInUs,usableOutUs,description,providerId,providerName,model,analysisJson,analyzedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(projectId, contentFingerprint) DO NOTHING`)
    .run(randomUUID(), projectId, input.contentFingerprint, Math.round(durationUs), range.inUs, range.outUs,
      formulaAnalysisDescription(input.analysis), input.provider.id, input.provider.name, input.provider.model,
      JSON.stringify(input.analysis), new Date().toISOString());
  return readFormulaMaterialAnalysis(db, projectId, input.contentFingerprint)!;
}

/**
 * 生成前检查：本批公式用到、但还没有画面分析的非口播素材。
 *
 * 只统计正式、可用的文件：预览/代理文件不算，副本丢失的也算不了。
 * 口径与生成一致——传进来的编号是这次真正要生成的脚本用到的编号。
 */
export function formulaMaterialAnalysisGap(db: Database.Database, projectId: string, batchId: string,
  onlyCodes?: readonly string[]): FormulaMaterialAnalysisGap {
  const scripts = readFormulaInputs(db, projectId, batchId).scripts?.rows ?? [];
  const referenced = new Set<string>(onlyCodes ?? []);
  if (!onlyCodes) {
    for (const row of scripts) {
      if (!('codes' in row)) continue;
      for (const code of row.codes) referenced.add(code);
    }
  }
  const index = getFormulaMaterialIndex(db, projectId, batchId);
  const analysed = listFormulaMaterialAnalyses(db, projectId);
  const missingByCode: Record<string, number> = {};
  let missingSources = 0;
  for (const binding of index.bindings) {
    const code = binding.logicalCode;
    if (!code || !referenced.has(code)) continue;
    if (binding.excludedReason || !binding.available) continue;
    // 口播镜头不看画面：有效片段按原声说话起止算。
    if (isVoiceOver(code)) continue;
    if (analysed.has(binding.contentFingerprint)) continue;
    missingByCode[code] = (missingByCode[code] ?? 0) + 1;
    missingSources += 1;
  }
  return {
    missingCodes: Object.keys(missingByCode).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    missingByCode,
    missingSources,
  };
}
