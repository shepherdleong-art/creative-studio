import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { OneClickFilmError } from './errors.ts';
import {
  entryCode,
  parseEntryCount,
  parseSoundMode,
  parseStructurePlan,
  SCRIPT_TITLE_LIMIT,
  STRUCTURE_LABELS,
  structureAt,
  type SoundMode,
  type StoryStructure,
  type StructurePlan,
} from './contract.ts';
import { buildPrompt, replaceVoiceSection, reviewPromptForSettings, type FilmSubject, type PromptReview } from './prompt.ts';
import { normalizeEvidenceRefs, type SellingPointDraft } from './selling-points.ts';
import { requireAccessContext } from '../media-core/access-context.ts';

/**
 * 一键成片的持久化层。
 *
 * 身份约定：一个项目一个 run；run 下有若干分析版本（换图/改卖点会追加新版本）
 * 与目标成片条目（F01…F12）。条目身份稳定：调整数量只增减尾部条目，
 * 调整结构只重写结构变化的条目，其余手稿、配音与确认记录原样保留。
 */

export interface OneClickFilmRun {
  id: string;
  projectId: string;
  currentAnalysisId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OneClickFilmAnalysis {
  id: string;
  runId: string;
  projectId: string;
  versionNumber: number;
  sourceImageIds: string[];
  sourceFingerprint: string;
  productName: string;
  appearance: string;
  sceneClues: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
  providerId: string;
  model: string;
  confirmedAt: string | null;
  confirmedProductName: string;
  createdAt: string;
  updatedAt: string;
}

export interface OneClickFilmEntry {
  id: string;
  runId: string;
  projectId: string;
  ordinal: number;
  code: string;
  structure: StoryStructure;
  structureSource: 'auto' | 'batch' | 'individual';
  soundMode: SoundMode;
  status: 'pending' | 'draft' | 'confirmed';
  title: string;
  outline: string;
  narration: string;
  promptText: string;
  promptBaseline: string[];
  promptDurationSec: number;
  promptAspectRatio: string;
  scriptRevision: number;
  scriptConfirmedAt: string | null;
  analysisId: string;
  productNameSnapshot: string;
  sellingPointsSnapshot: string[];
  ttsProviderId: string;
  ttsVoice: string;
  ttsSpeed: number;
  createdAt: string;
  updatedAt: string;
}

interface RunRow {
  id: string;
  projectId: string;
  currentAnalysisId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AnalysisRow {
  id: string;
  runId: string;
  projectId: string;
  versionNumber: number;
  sourceImageIdsJson: string;
  sourceFingerprint: string;
  productName: string;
  appearance: string;
  sceneClues: string;
  status: OneClickFilmAnalysis['status'];
  errorCode: string | null;
  errorMessage: string | null;
  providerId: string;
  model: string;
  confirmedAt: string | null;
  confirmedProductName: string;
  createdAt: string;
  updatedAt: string;
}

interface EntryRow {
  id: string;
  runId: string;
  projectId: string;
  ordinal: number;
  code: string;
  structure: StoryStructure;
  structureSource: OneClickFilmEntry['structureSource'];
  soundMode: SoundMode;
  status: OneClickFilmEntry['status'];
  title: string;
  outline: string;
  narration: string;
  promptText: string;
  promptBaselineJson: string;
  promptDurationSec: number;
  promptAspectRatio: string;
  scriptRevision: number;
  scriptConfirmedAt: string | null;
  scriptConfirmedJson: string;
  analysisId: string;
  productNameSnapshot: string;
  sellingPointsSnapshotJson: string;
  ttsProviderId: string;
  ttsVoice: string;
  ttsSpeed: number;
  createdAt: string;
  updatedAt: string;
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringArray(value: string): string[] {
  return parseJsonArray(value).filter((item): item is string => typeof item === 'string');
}

function toRun(row: RunRow): OneClickFilmRun {
  return { ...row };
}

function toAnalysis(row: AnalysisRow): OneClickFilmAnalysis {
  return {
    ...row,
    sourceImageIds: stringArray(row.sourceImageIdsJson),
  };
}

function toEntry(row: EntryRow): OneClickFilmEntry {
  const promptBaseline = stringArray(row.promptBaselineJson);
  const narrative = promptBaseline.find((block) => block.startsWith('【叙事】\n'))?.split('\n')[1];
  const suffix = ` · ${STRUCTURE_LABELS[row.structure]}`;
  const previousTitle = narrative?.endsWith(suffix) ? narrative.slice(0, -suffix.length) : '';
  return {
    ...row,
    title: (row.title?.trim() || previousTitle || row.productNameSnapshot || '').slice(0, SCRIPT_TITLE_LIMIT),
    promptBaseline,
    sellingPointsSnapshot: stringArray(row.sellingPointsSnapshotJson),
  };
}

/** 素材指纹：图片身份集合的稳定哈希，换图必须触发重新分析。 */
export function fingerprintImages(imageIds: readonly string[]): string {
  return createHash('sha256').update([...imageIds].sort().join('\n')).digest('hex');
}

export function getOrCreateRun(db: Database.Database, projectId: string): OneClickFilmRun {
  const access = requireAccessContext();
  if (access.kind === 'team') access.assertAccess('project', projectId, 'write');
  return db.transaction(() => {
    const existing = db.prepare(`SELECT * FROM one_click_film_runs WHERE projectId = ?`).get(projectId) as RunRow | undefined;
    if (existing) return toRun(existing);
    const now = new Date().toISOString();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO one_click_film_runs (id, projectId, ownerKey, currentAnalysisId, createdAt, updatedAt)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(id, projectId, access.actor.userId, now, now);
    access.registerInheritedScope({
      resourceType: 'one_click_film_run', resourceId: id,
      parent: { resourceType: 'project', resourceId: projectId },
    });
    return toRun(db.prepare(`SELECT * FROM one_click_film_runs WHERE id = ?`).get(id) as RunRow);
  }).immediate();
}

export function getRunForProject(db: Database.Database, projectId: string): OneClickFilmRun | null {
  const row = db.prepare(`SELECT * FROM one_click_film_runs WHERE projectId = ?`).get(projectId) as RunRow | undefined;
  return row ? toRun(row) : null;
}

/**
 * 只读入口：项目已有一键成片记录时返回它，没有就返回 null。
 * GET 不得建记录（读请求不应要求写权限，也不该在只读会话里产生副作用）。
 */
export function findRunForProject(db: Database.Database, projectId: string): OneClickFilmRun | null {
  return getRunForProject(db, projectId);
}

export function listAnalyses(db: Database.Database, runId: string): OneClickFilmAnalysis[] {
  return (db.prepare(`SELECT * FROM one_click_film_analyses WHERE runId = ? ORDER BY versionNumber ASC`)
    .all(runId) as AnalysisRow[]).map(toAnalysis);
}

export function getAnalysis(db: Database.Database, analysisId: string): OneClickFilmAnalysis | null {
  const row = db.prepare(`SELECT * FROM one_click_film_analyses WHERE id = ?`).get(analysisId) as AnalysisRow | undefined;
  return row ? toAnalysis(row) : null;
}

export function getCurrentAnalysis(db: Database.Database, run: OneClickFilmRun): OneClickFilmAnalysis | null {
  if (!run.currentAnalysisId) return null;
  return getAnalysis(db, run.currentAnalysisId);
}

export function listSellingPoints(db: Database.Database, analysisId: string): SellingPointDraft[] {
  const rows = db.prepare(`
    SELECT * FROM one_click_film_selling_points WHERE analysisId = ? ORDER BY seq ASC
  `).all(analysisId) as Array<{
    text: string; originalText: string; sourceImageId: string | null; sourceLabel: string;
    evidenceRefsJson: string; kind: string; selected: number; edited: number;
  }>;
  return rows.map((row) => ({
    text: row.text,
    originalText: row.originalText || row.text,
    sourceImageId: row.sourceImageId,
    sourceLabel: row.sourceLabel,
    evidenceRefs: normalizeEvidenceRefs(parseJsonArray(row.evidenceRefsJson)),
    kind: (['appearance', 'usage', 'claim'] as const).includes(row.kind as never) ? row.kind as SellingPointDraft['kind'] : 'claim',
    selected: row.selected === 1,
    edited: row.edited === 1,
  }));
}

export function createAnalysisVersion(db: Database.Database, input: {
  run: OneClickFilmRun;
  sourceImageIds: string[];
  productName?: string;
  appearance?: string;
  sceneClues?: string;
  status?: OneClickFilmAnalysis['status'];
  providerId?: string;
  model?: string;
}): OneClickFilmAnalysis {
  const now = new Date().toISOString();
  const id = uuidv4();
  const access = requireAccessContext();
  db.transaction(() => {
    const nextVersion = ((db.prepare(`SELECT MAX(versionNumber) AS v FROM one_click_film_analyses WHERE runId = ?`)
      .get(input.run.id) as { v: number | null }).v ?? 0) + 1;
    db.prepare(`
      INSERT INTO one_click_film_analyses
        (id, runId, projectId, versionNumber, sourceImageIdsJson, sourceFingerprint, productName, appearance,
         sceneClues, status, providerId, model, rawJson, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(
      id, input.run.id, input.run.projectId, nextVersion,
      JSON.stringify(input.sourceImageIds), fingerprintImages(input.sourceImageIds),
      (input.productName ?? '').trim(), (input.appearance ?? '').trim(), (input.sceneClues ?? '').trim(),
      input.status ?? 'queued', input.providerId ?? '', input.model ?? '', now, now,
    );
    db.prepare(`UPDATE one_click_film_runs SET currentAnalysisId = ?, updatedAt = ? WHERE id = ?`)
      .run(id, now, input.run.id);
    access.registerInheritedScope({
      resourceType: 'one_click_film_analysis', resourceId: id,
      parent: { resourceType: 'one_click_film_run', resourceId: input.run.id },
    });
  }).immediate();
  return getAnalysis(db, id)!;
}

export function replaceSellingPoints(
  db: Database.Database,
  analysisId: string,
  points: SellingPointDraft[],
): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM one_click_film_selling_points WHERE analysisId = ?`).run(analysisId);
    const insert = db.prepare(`
      INSERT INTO one_click_film_selling_points
        (id, analysisId, seq, text, originalText, sourceImageId, sourceLabel, evidenceRefsJson, kind, selected, edited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    points.forEach((point, index) => {
      insert.run(
        uuidv4(), analysisId, index, point.text, point.originalText ?? point.text,
        point.sourceImageId, point.sourceLabel, JSON.stringify(point.evidenceRefs),
        point.kind, point.selected ? 1 : 0, point.edited ? 1 : 0,
      );
    });
  }).immediate();
}

export function markAnalysisSucceeded(db: Database.Database, input: {
  analysisId: string;
  productName: string;
  appearance: string;
  sceneClues: string;
  points: SellingPointDraft[];
  raw: unknown;
  providerId: string;
  model: string;
}): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE one_click_film_analyses
      SET productName = ?, appearance = ?, sceneClues = ?, status = 'succeeded',
          errorCode = NULL, errorMessage = NULL, providerId = ?, model = ?, rawJson = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      input.productName, input.appearance, input.sceneClues,
      input.providerId, input.model, JSON.stringify(input.raw ?? {}), now, input.analysisId,
    );
    replaceSellingPoints(db, input.analysisId, input.points);
  }).immediate();
}

export function markAnalysisFailed(db: Database.Database, input: {
  analysisId: string;
  code: string;
  message: string;
}): void {
  db.prepare(`
    UPDATE one_click_film_analyses
    SET status = 'failed', errorCode = ?, errorMessage = ?, updatedAt = ?
    WHERE id = ?
  `).run(input.code, input.message.slice(0, 500), new Date().toISOString(), input.analysisId);
}

/** 分析确认：写入选用文字与来源，返回可交给脚本页的确认内容。 */
export function confirmAnalysis(db: Database.Database, input: {
  analysisId: string;
  productName: string;
  points: SellingPointDraft[];
}): OneClickFilmAnalysis {
  return db.transaction(() => {
    const current = getAnalysis(db, input.analysisId);
    if (!current || current.status !== 'succeeded') throw new OneClickFilmError('invalid_input', '请等待素材分析成功后确认');
    const run = getRunForProject(db, current.projectId);
    if (!run || run.currentAnalysisId !== current.id) throw new OneClickFilmError('invalid_input', '请确认最新的素材分析');
    const comparable = (points: SellingPointDraft[]) => JSON.stringify(points.filter((point) => point.selected)
      .map(({ text, sourceImageId, evidenceRefs }) => ({ text, sourceImageId, evidenceRefs })));
    if (current.confirmedAt && current.confirmedProductName === input.productName
      && comparable(listSellingPoints(db, current.id)) === comparable(input.points)) return current;
    const id = current.confirmedAt ? createAnalysisVersion(db, {
      run, sourceImageIds: current.sourceImageIds, productName: input.productName,
      appearance: current.appearance, sceneClues: current.sceneClues, status: 'succeeded',
      providerId: current.providerId, model: current.model,
    }).id : current.id;
    const now = new Date().toISOString();
    replaceSellingPoints(db, id, input.points);
    db.prepare(`
      UPDATE one_click_film_analyses
      SET productName = ?, confirmedAt = ?, confirmedProductName = ?, updatedAt = ?
      WHERE id = ?
    `).run(input.productName, now, input.productName, now, id);
    return getAnalysis(db, id)!;
  }).immediate();
}

export function listEntries(db: Database.Database, runId: string): OneClickFilmEntry[] {
  return (db.prepare(`SELECT * FROM one_click_film_entries WHERE runId = ? AND retired = 0 ORDER BY ordinal ASC`)
    .all(runId) as EntryRow[]).map(toEntry);
}

export function getEntry(db: Database.Database, runId: string, code: string): OneClickFilmEntry {
  const row = db.prepare(`SELECT * FROM one_click_film_entries WHERE runId = ? AND code = ? AND retired=0`)
    .get(runId, code.trim().toUpperCase()) as EntryRow | undefined;
  if (!row) throw new OneClickFilmError('not_found', `找不到成片条目 ${code}`, 404);
  return toEntry(row);
}

function subjectOf(analysis: OneClickFilmAnalysis, points: SellingPointDraft[]): FilmSubject {
  return {
    product: analysis.confirmedProductName || analysis.productName,
    appearance: analysis.appearance,
    points: points.filter((point) => point.selected).map((point) => point.text),
    genre: '淘系种草',
  };
}

export interface ScriptCopy {
  title: string;
  angle: string;
  story: string;
  narration: string;
  directions?: string[];
}

const STRUCTURE_ANGLE: Record<StoryStructure, string> = {
  scene: '日常场景 → 使用体验 → 个人感受',
  result: '先看结果 → 回看使用过程 → 点出原因',
  problem: '提出困扰 → 亲身试用 → 回答问题',
};

/** 确定性文案骨架：同一输入可重复生成，重做时才带 revision 产生可区分的新稿。 */
function scriptCopy(input: {
  structure: StoryStructure;
  subject: FilmSubject;
  index: number;
  revision: number;
}): ScriptCopy {
  const { structure, subject, index, revision } = input;
  const point = subject.points[index % Math.max(1, subject.points.length)] || '日常使用体验';
  const product = subject.product;
  const moment = ['下班后', '周末午后', '午休时', '一天开始时', '忙完手头的事后', '休息日'][index % 6];
  const take = revision > 0 ? revision : 0;
  const opening = take ? `这一次，我先把手机放到一边。` : `${moment}，我给自己留了几分钟。`;
  const closing = take ? `那条消息，一会儿再回。` : `这个小习惯，我想留下来。`;
  const action = `人物自然走近${product}，完成一次日常使用动作，让「${point}」清楚可见。`;
  const voice = `我用上${product}，亲自试了试${point}。`;
  const question = `在意${point}，用上${product}会是什么感受？`;
  const resultLine = `人物完成使用后稍作停留，呈现对${point}的直观感受`;

  switch (structure) {
    case 'result':
      return {
        title: `为什么${moment}会选${product}`,
        angle: STRUCTURE_ANGLE.result,
        story: `${resultLine}。再回到${moment}刚用上${product}的时候，${action}`,
        narration: `${closing}刚才是怎么开始的？${opening}${voice}试过${product}，才知道这个细节对我有多重要。`,
      };
    case 'problem':
      return {
        title: `${moment}，我最在意的一个细节`,
        angle: STRUCTURE_ANGLE.problem,
        story: `${question}带着这个疑问，${action}结尾用刚才的体验作答。`,
        narration: `${question}${opening}${voice}${closing}`,
      };
    default:
      return {
        title: `${moment}，用上${product}的那一刻`,
        angle: STRUCTURE_ANGLE.scene,
        story: `${moment}，${action}在这个日常片刻里，带出${product}的${point}。`,
        narration: `${opening}${voice}${closing}`,
      };
  }
}

function promptFor(input: {
  subject: FilmSubject;
  structure: StoryStructure;
  sound: SoundMode;
  copy: ScriptCopy;
  durationSec: number;
  aspectRatio: string;
}): { text: string; baseline: string[] } {
  const blocks = {
    subject: input.subject, structure: input.structure, sound: input.sound,
    title: input.copy.title, angle: input.copy.angle, story: input.copy.story,
    narration: input.copy.narration, durationSec: input.durationSec, aspectRatio: input.aspectRatio,
    directions: input.copy.directions,
  };
  const text = buildPrompt(blocks);
  // baseline 由同一输入重新计算，供后续判断「是否被手改」。
  const baseline = text.split('\n\n');
  return { text, baseline };
}

export interface ApplyScriptPlanInput {
  count: unknown;
  plan: unknown;
  soundMode: unknown;
  durationSec?: number;
  aspectRatio?: string;
  tts?: { providerId?: string; voice?: string; speed?: number };
}

export interface ApplyScriptPlanResult {
  entries: OneClickFilmEntry[];
  added: string[];
  rewritten: string[];
  removed: string[];
  kept: string[];
}

/**
 * 应用数量/结构/声音设置。
 * - 数量：尾部增删，稳定身份不变；
 * - 结构：只重写结构变化的条目，其余保留手稿与确认记录；
 * - 声音：整批切换时受影响条目回到待确认（TTS 需重新准备配音）。
 */
export function applyScriptPlan(db: Database.Database, input: {
  run: OneClickFilmRun;
  analysis: OneClickFilmAnalysis;
  points: SellingPointDraft[];
  plan: ApplyScriptPlanInput;
  copies?: Map<number, ScriptCopy>;
}): ApplyScriptPlanResult {
  const count = parseEntryCount(input.plan.count);
  const plan: StructurePlan = parseStructurePlan(input.plan.plan);
  const sound = parseSoundMode(input.plan.soundMode);
  const subject = subjectOf(input.analysis, input.points);
  if (subject.points.length === 0) throw new OneClickFilmError('invalid_input', '请先在分析页勾选至少一项卖点');
  if (!subject.product) throw new OneClickFilmError('invalid_input', '请先确认产品名称');

  const durationSec = Number.isFinite(Number(input.plan.durationSec)) && Number(input.plan.durationSec) > 0
    ? Math.round(Number(input.plan.durationSec)) : 15;
  const aspectRatio = (input.plan.aspectRatio || '3:4').trim();
  const tts = input.plan.tts ?? {};
  const existing = listEntries(db, input.run.id);
  const added: string[] = [];
  const rewritten: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const entry of existing) {
      if (entry.ordinal > count) {
        db.prepare(`UPDATE one_click_film_entries SET retired = 1 WHERE id = ?`).run(entry.id);
        removed.push(entry.code);
      }
    }
    const insert = db.prepare(`
      INSERT INTO one_click_film_entries
        (id, runId, projectId, ordinal, code, structure, structureSource, soundMode, status, title, outline, narration,
         promptText, promptBaselineJson, promptDurationSec, promptAspectRatio, scriptRevision, scriptConfirmedAt,
         scriptConfirmedJson, analysisId, productNameSnapshot, sellingPointsSnapshotJson, ttsProviderId, ttsVoice,
         ttsSpeed, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 0, NULL, '{}', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE one_click_film_entries
      SET structure = ?, structureSource = ?, soundMode = ?, status = ?, title = ?, outline = ?, narration = ?, promptText = ?,
          promptBaselineJson = ?, promptDurationSec = ?, promptAspectRatio = ?, scriptRevision = ?,
          scriptConfirmedAt = ?, scriptConfirmedJson = '{}', analysisId = ?, productNameSnapshot = ?,
          sellingPointsSnapshotJson = ?, ttsProviderId = ?, ttsVoice = ?, ttsSpeed = ?, updatedAt = ?
      WHERE id = ?
    `);
    const byOrdinal = new Map((db.prepare(`SELECT * FROM one_click_film_entries WHERE runId = ?`)
      .all(input.run.id) as EntryRow[]).map((row) => [row.ordinal, toEntry(row)]));

    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      const structure = structureAt(plan, ordinal - 1);
      const structureSource = plan.mode === 'individual' ? 'individual' : plan.mode === 'batch' ? 'batch' : 'auto';
      const previous = byOrdinal.get(ordinal);
      const restored = previous && db.prepare(`UPDATE one_click_film_entries SET retired = 0 WHERE id = ? AND retired = 1`).run(previous.id).changes > 0;
      if (restored) added.push(previous.code);
      const subjectChanged = !previous
        || previous.analysisId !== input.analysis.id
        || previous.productNameSnapshot !== subject.product
        || JSON.stringify(previous.sellingPointsSnapshot) !== JSON.stringify(subject.points);
      const structureChanged = !previous || previous.structure !== structure;
      const soundChanged = !previous || previous.soundMode !== sound;

      if (!previous) {
        const code = entryCode(ordinal);
        const copy = input.copies?.get(ordinal) ?? scriptCopy({ structure, subject, index: ordinal - 1, revision: 0 });
        const prompt = promptFor({ subject, structure, sound, copy, durationSec, aspectRatio });
        insert.run(
          uuidv4(), input.run.id, input.run.projectId, ordinal, code, structure, structureSource, sound,
          copy.title, copy.story, copy.narration, prompt.text, JSON.stringify(prompt.baseline), durationSec, aspectRatio,
          input.analysis.id, subject.product, JSON.stringify(subject.points),
          tts.providerId ?? '', tts.voice ?? '', Number(tts.speed) || 1, now, now,
        );
        added.push(code);
        continue;
      }

      if (structureChanged || subjectChanged) {
        const copy = input.copies?.get(ordinal) ?? scriptCopy({ structure, subject, index: ordinal - 1, revision: previous.scriptRevision });
        const prompt = promptFor({ subject, structure, sound, copy, durationSec, aspectRatio });
        update.run(
          structure, structureSource, sound, 'pending', copy.title, copy.story, copy.narration, prompt.text,
          JSON.stringify(prompt.baseline), durationSec, aspectRatio, previous.scriptRevision,
          null, input.analysis.id, subject.product, JSON.stringify(subject.points),
          tts.providerId ?? previous.ttsProviderId, tts.voice ?? previous.ttsVoice,
          Number(tts.speed) || previous.ttsSpeed, now, previous.id,
        );
        if (!restored) rewritten.push(previous.code);
        continue;
      }

      if (soundChanged) {
        // 只替换声音段：手改的分镜与叙事原样保留。
        const promptText = replaceVoiceSection(previous.promptText, {
          sound,
          narration: previous.narration,
          durationSec: previous.promptDurationSec,
        });
        const baseline = replaceVoiceSection(previous.promptBaseline.join('\n\n'), {
          sound,
          narration: previous.narration,
          durationSec: previous.promptDurationSec,
        }).split('\n\n');
        update.run(
          structure, structureSource, sound, 'pending', previous.title, previous.outline, previous.narration, promptText,
          JSON.stringify(baseline), previous.promptDurationSec, previous.promptAspectRatio,
          previous.scriptRevision, null, input.analysis.id, subject.product, JSON.stringify(subject.points),
          tts.providerId ?? previous.ttsProviderId, tts.voice ?? previous.ttsVoice,
          Number(tts.speed) || previous.ttsSpeed, now, previous.id,
        );
        if (!restored) rewritten.push(previous.code);
        continue;
      }

      db.prepare(`UPDATE one_click_film_entries SET structureSource = ?, ttsProviderId = ?, ttsVoice = ?, ttsSpeed = ?, updatedAt = ? WHERE id = ?`)
        .run(structureSource, tts.providerId ?? previous.ttsProviderId, tts.voice ?? previous.ttsVoice,
          Number(tts.speed) || previous.ttsSpeed, now, previous.id);
      if (!restored) kept.push(previous.code);
    }
  }).immediate();

  return { entries: listEntries(db, input.run.id), added, rewritten, removed, kept };
}

function saveRevision(db: Database.Database, entry: OneClickFilmEntry, origin: 'generated' | 'redraft' | 'manual' | 'structure_change'): void {
  const next = ((db.prepare(`SELECT MAX(revisionNumber) AS v FROM one_click_film_script_revisions WHERE entryId = ?`)
    .get(entry.id) as { v: number | null }).v ?? 0) + 1;
  db.prepare(`
    INSERT INTO one_click_film_script_revisions
      (id, entryId, revisionNumber, origin, title, outline, narration, promptText, promptBaselineJson,
       promptDurationSec, promptAspectRatio, structure, analysisId, sellingPointsSnapshotJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(), entry.id, next, origin, entry.title, entry.outline, entry.narration, entry.promptText,
    JSON.stringify(entry.promptBaseline), entry.promptDurationSec, entry.promptAspectRatio,
    entry.structure, entry.analysisId, JSON.stringify(entry.sellingPointsSnapshot), new Date().toISOString(),
  );
}

export function updateEntryDraft(db: Database.Database, input: {
  run: OneClickFilmRun;
  code: string;
  title?: string;
  outline?: string;
  narration?: string;
  promptText?: string;
}): OneClickFilmEntry {
  const entry = getEntry(db, input.run.id, input.code);
  const title = input.title === undefined ? entry.title : input.title.trim().slice(0, SCRIPT_TITLE_LIMIT);
  if (input.title !== undefined && !title) throw new OneClickFilmError('invalid_input', '成片标题不能为空');
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE one_click_film_entries
    SET title = ?, outline = ?, narration = ?, promptText = ?, status = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    title, input.outline ?? entry.outline,
    input.narration ?? entry.narration,
    input.promptText ?? entry.promptText,
    'draft', now, entry.id,
  );
  return getEntry(db, input.run.id, input.code);
}

export function confirmEntry(db: Database.Database, input: {
  run: OneClickFilmRun;
  code: string;
  title?: string;
  outline?: string;
  narration?: string;
  promptText?: string;
}): OneClickFilmEntry {
  const entry = updateEntryDraft(db, input);
  const outline = entry.outline.trim();
  const narration = entry.narration.trim();
  const promptText = entry.promptText.trim();
  if (!outline) throw new OneClickFilmError('invalid_input', `${entry.code} 的大纲不能为空`);
  if (entry.soundMode !== 'none' && !narration) throw new OneClickFilmError('invalid_input', `${entry.code} 的口播不能为空`);
  if (!promptText) throw new OneClickFilmError('invalid_input', `${entry.code} 的提示词不能为空`);
  // 确认稿必须把最终口播写进提示词：视频模型收到的是这一步确认的全文，
  // 不能停留在生成初稿时的旧旁白。
  const finalPrompt = replaceVoiceSection(promptText, {
    sound: entry.soundMode,
    narration,
    durationSec: entry.promptDurationSec,
  });
  if (finalPrompt !== promptText) {
    db.prepare(`UPDATE one_click_film_entries SET promptText = ? WHERE id = ?`).run(finalPrompt, entry.id);
  }
  const now = new Date().toISOString();
  const confirmedJson = JSON.stringify({
    title: entry.title, outline, narration, promptText: finalPrompt,
    soundMode: entry.soundMode,
    structure: entry.structure,
    analysisId: entry.analysisId,
    productName: entry.productNameSnapshot,
    sellingPoints: entry.sellingPointsSnapshot,
    promptDurationSec: entry.promptDurationSec,
    promptAspectRatio: entry.promptAspectRatio,
    scriptRevision: entry.scriptRevision,
  });
  db.transaction(() => {
    db.prepare(`
      UPDATE one_click_film_entries
      SET status = 'confirmed', scriptConfirmedAt = ?, scriptConfirmedJson = ?, updatedAt = ?
      WHERE id = ?
    `).run(now, confirmedJson, now, entry.id);
    saveRevision(db, { ...entry, outline, narration, promptText: finalPrompt }, 'manual');
  }).immediate();
  return getEntry(db, input.run.id, input.code);
}

/**
 * 单条重做：沿用该条结构与已选卖点，重写大纲/口播/分镜，回到待确认。
 * 不触碰其他条目的手稿、配音与确认记录。
 */
export function redraftEntry(db: Database.Database, input: {
  run: OneClickFilmRun;
  code: string;
  copy?: ScriptCopy;
  expectedRevision?: number;
}): OneClickFilmEntry {
  const entry = getEntry(db, input.run.id, input.code);
  if (input.expectedRevision !== undefined && input.expectedRevision !== entry.scriptRevision) return entry;
  const analysis = getAnalysis(db, entry.analysisId);
  if (!analysis) throw new OneClickFilmError('not_found', '该条目引用的分析版本已不存在', 404);
  const subject: FilmSubject = {
    product: entry.productNameSnapshot,
    appearance: analysis.appearance,
    points: entry.sellingPointsSnapshot,
    genre: '淘系种草',
  };
  const revision = entry.scriptRevision + 1;
  const copy = input.copy ?? scriptCopy({ structure: entry.structure, subject, index: entry.ordinal - 1, revision });
  const prompt = promptFor({
    subject, structure: entry.structure, sound: entry.soundMode, copy,
    durationSec: entry.promptDurationSec, aspectRatio: entry.promptAspectRatio,
  });
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE one_click_film_entries
      SET title = ?, outline = ?, narration = ?, promptText = ?, promptBaselineJson = ?, scriptRevision = ?,
          status = 'pending', scriptConfirmedAt = NULL, scriptConfirmedJson = '{}', updatedAt = ?
      WHERE id = ?
    `).run(copy.title, copy.story, copy.narration, prompt.text, JSON.stringify(prompt.baseline), revision, now, entry.id);
    saveRevision(db, {
      ...entry, title: copy.title, outline: copy.story, narration: copy.narration, promptText: prompt.text,
      promptBaseline: prompt.baseline,
    }, 'redraft');
  }).immediate();
  return getEntry(db, input.run.id, input.code);
}

/** 重新生成全部：整批设置区单独发起，逐条按各自结构重做。 */
export function redraftAll(db: Database.Database, run: OneClickFilmRun): OneClickFilmEntry[] {
  for (const entry of listEntries(db, run.id)) redraftEntry(db, { run, code: entry.code });
  return listEntries(db, run.id);
}

/** 生成设置（时长/画幅）变化后的提示词复核：返回每条建议稿与冲突标记。 */
export function reviewPrompt(db: Database.Database, input: {
  run: OneClickFilmRun;
  durationSec: number;
  aspectRatio: string;
}): Array<{ code: string; review: PromptReview }> {
  return listEntries(db, input.run.id).map((entry) => {
    const analysis = getAnalysis(db, entry.analysisId);
    const subject: FilmSubject = {
      product: entry.productNameSnapshot,
      appearance: analysis?.appearance ?? '',
      points: entry.sellingPointsSnapshot,
      genre: '淘系种草',
    };
    const copy = scriptCopy({ structure: entry.structure, subject, index: entry.ordinal - 1, revision: entry.scriptRevision });
    return {
      code: entry.code,
      review: reviewPromptForSettings({
        savedText: entry.promptText,
        savedBaseline: entry.promptBaseline,
        savedDurationSec: entry.promptDurationSec,
        next: {
          subject,
          structure: entry.structure,
          sound: entry.soundMode,
          // 建议稿必须沿用手改的大纲与口播，只按新时长/画幅重排分镜与声音。
          title: entry.title || copy.title,
          angle: copy.angle,
          story: entry.outline,
          narration: entry.narration,
          durationSec: input.durationSec, aspectRatio: input.aspectRatio,
        },
      }),
    };
  });
}

export function applyPromptReview(db: Database.Database, input: {
  run: OneClickFilmRun;
  code: string;
  promptText: string;
  durationSec: number;
  aspectRatio: string;
}): OneClickFilmEntry {
  const entry = getEntry(db, input.run.id, input.code);
  const text = input.promptText.trim();
  if (!text) throw new OneClickFilmError('invalid_input', '提示词不能为空');
  db.prepare(`
    UPDATE one_click_film_entries
    SET promptText = ?, promptDurationSec = ?, promptAspectRatio = ?, status = 'pending',
        scriptConfirmedAt = NULL, scriptConfirmedJson = '{}', updatedAt = ?
    WHERE id = ?
  `).run(text, input.durationSec, input.aspectRatio, new Date().toISOString(), entry.id);
  return getEntry(db, input.run.id, input.code);
}
