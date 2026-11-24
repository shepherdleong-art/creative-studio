import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { completeJson, getAvailableProviders } from '../script-providers/index.ts';
import { parseEntryCount, parseSoundMode, parseStructurePlan, SCRIPT_TITLE_LIMIT, STRUCTURE_LABELS, structureAt, type SoundMode, type StoryStructure } from './contract.ts';
import { OneClickFilmError } from './errors.ts';
import type { SellingPointDraft } from './selling-points.ts';
import { getAnalysis, getEntry, listEntries, redraftEntry, type ApplyScriptPlanInput,
  type OneClickFilmAnalysis, type OneClickFilmRun, type ScriptCopy } from './store.ts';

async function generateCopy(input: {
  run: OneClickFilmRun; analysis: OneClickFilmAnalysis; points: string[]; code: string; structure: StoryStructure;
  sound: SoundMode; durationSec: number; aspectRatio: string;
  previous?: { revision: number; outline: string; narration: string; promptText: string };
}): Promise<ScriptCopy> {
  const provider = getAvailableProviders().find((item) => item.id === input.analysis.providerId && item.configured)
    ?? getAvailableProviders().find((item) => item.configured);
  if (!provider) throw new OneClickFilmError('invalid_input', '没有可用的脚本模型');
  const task = {
    task: 'write_one_click_film_script',
    product: input.analysis.confirmedProductName || input.analysis.productName,
    appearance: input.analysis.appearance, evidence: input.points, entry: input.code,
    structure: STRUCTURE_LABELS[input.structure], sound: input.sound, duration: input.durationSec,
    aspectRatio: input.aspectRatio, previous: input.previous,
    output: { title: '成片及封面标题，结合本条主卖点，简明具体', angle: 'string', outline: 'string', narration: 'string',
      shots: ['景别｜机位和运镜｜具体人物实际使用产品的动作'] },
  };
  const revision = createHash('sha256').update(JSON.stringify(task)).digest('hex');
  const response = await completeJson<{
    title?: unknown; angle?: unknown; outline?: unknown; narration?: unknown; shots?: unknown;
  }>({
    providerId: provider.id,
    systemPrompt: '写一条淘系种草短片。只返回 JSON。用给定结构讲清已选卖点，避免素材不支持的主张。分镜按叙事顺序，给出至少六镜和具体动作，无封面、烧录字幕、花字或音乐。提供旧稿时改写大纲、口播与分镜，不照抄。无配音时口播留空。',
    userPrompt: JSON.stringify(task), maxTokens: 3600,
    usageContext: { enabled: true, projectId: input.run.projectId, refType: 'one-click-film-script', refId: input.run.id },
    executionContext: { taskId: input.run.id, step: `script-${input.code}`, inputRevision: revision,
      scope: { resourceType: 'project', resourceId: input.run.projectId } },
  });
  const string = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const title = string(response?.title, SCRIPT_TITLE_LIMIT).replace(/[\r\n]+/g, ' ');
  const angle = string(response?.angle, 240);
  const story = string(response?.outline, 1500);
  const narration = input.sound === 'none' ? '' : string(response?.narration, 1700);
  const directions = Array.isArray(response?.shots) ? response.shots.map((shot) => string(shot, 350)).filter(Boolean).slice(0, 12) : [];
  if (!title || !angle || !story || (input.sound !== 'none' && !narration) || directions.length < 6) {
    throw new OneClickFilmError('invalid_input', `${input.code} 返回的脚本缺少标题、大纲、口播或完整分镜，请重试`);
  }
  return { title, angle, story, narration, directions };
}

export async function generatePlanCopies(db: Database.Database, input: {
  run: OneClickFilmRun; analysis: OneClickFilmAnalysis; points: SellingPointDraft[]; plan: ApplyScriptPlanInput;
}): Promise<Map<number, ScriptCopy>> {
  const count = parseEntryCount(input.plan.count);
  const plan = parseStructurePlan(input.plan.plan);
  const sound = parseSoundMode(input.plan.soundMode);
  const points = input.points.filter((point) => point.selected).map((point) => point.text);
  const existing = new Map(listEntries(db, input.run.id, 'all').map((entry) => [entry.ordinal, entry]));
  const copies = new Map<number, ScriptCopy>();
  for (let ordinal = 1; ordinal <= count; ordinal++) {
    const entry = existing.get(ordinal);
    const structure = structureAt(plan, ordinal - 1);
    if (entry?.structure === structure && entry.analysisId === input.analysis.id
      && entry.productNameSnapshot === (input.analysis.confirmedProductName || input.analysis.productName)
      && JSON.stringify(entry.sellingPointsSnapshot) === JSON.stringify(points)) continue;
    const code = `F${String(ordinal).padStart(2, '0')}`;
    copies.set(ordinal, await generateCopy({
      run: input.run, analysis: input.analysis, points, code, structure, sound,
      durationSec: input.plan.durationSec ?? 15, aspectRatio: input.plan.aspectRatio ?? '3:4',
    }));
  }
  return copies;
}

export async function generateRedraft(db: Database.Database, run: OneClickFilmRun, code: string, revision?: number) {
  const entry = getEntry(db, run.id, code);
  if (revision !== undefined && revision !== entry.scriptRevision) return entry;
  const analysis = getAnalysis(db, entry.analysisId);
  if (!analysis) throw new OneClickFilmError('not_found', '该条目引用的素材分析已不存在', 404);
  const copy = await generateCopy({
    run, analysis, points: entry.sellingPointsSnapshot, code, structure: entry.structure,
    sound: entry.soundMode, durationSec: entry.promptDurationSec, aspectRatio: entry.promptAspectRatio,
    previous: { revision: entry.scriptRevision, outline: entry.outline, narration: entry.narration, promptText: entry.promptText },
  });
  return redraftEntry(db, { run, code, copy, expectedRevision: entry.scriptRevision });
}
