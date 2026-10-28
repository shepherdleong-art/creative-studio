/**
 * 实拍混剪排片计算：只读核对脚本（手动验收用，不进自动测试）。
 *
 * 只读真实数据库，不写库、不调模型、不渲染。用和原型一样的模拟挑选，
 * 把 300 条脚本 × 两种声音方式过一遍，打印漏读、静帧、声音重叠、片尾和时长中位数。
 *
 * 用法：
 *   node scripts/live-mixcut-scheduling-audit.ts
 *   node scripts/live-mixcut-scheduling-audit.ts --batch "批次 6" --limit 50
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../lib/data-root.ts';
import {
  arrangeFormulaTime, assignFormulaVoice, estimatedSpeechUs, normalizeSpeechText, validateFormulaShortFilm,
  type NarrationTake, type SchedulingFile, type SchedulingJudgment, type SchedulingSlotMaterial,
} from '../lib/live-mixcut/scheduling/index.ts';
import { cleanSourceSpeech } from '../lib/live-mixcut/source-speech-clean.ts';
import { parseMaterialFilename } from '../lib/live-mixcut/formula/parse.ts';
import { readFormulaWorkbook } from '../lib/live-mixcut/formula/workbook.ts';

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const projectName = value('--project') ?? '20261026-B店-ps889-实拍混剪-pk测试';
const batchName = value('--batch') ?? projectName;
const rate = Number(value('--rate') ?? 4.11);
const limit = value('--limit') ? Number(value('--limit')) : Infinity;
const databasePath = path.join(dataRoot(), 'data', 'workbench.db');
if (!fs.existsSync(databasePath)) throw new Error(`找不到数据库：${databasePath}`);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

const project = db.prepare('SELECT id,name FROM live_mixcut_projects WHERE name=? AND deletedAt IS NULL').get(projectName) as
  { id: string; name: string } | undefined;
if (!project) throw new Error(`找不到任务：${projectName}`);
const production = db.prepare(`SELECT id,name,currentVersionId FROM live_mixcut_productions
  WHERE projectId=? AND name=? AND deletedAt IS NULL`).get(project.id, batchName) as
  { id: string; name: string; currentVersionId: string | null } | undefined;
if (!production) throw new Error(`找不到批次：${batchName}`);
const collection = db.prepare('SELECT id,scriptsSessionId FROM live_mixcut_formula_collections WHERE batchId=?')
  .get(production.id) as { id: string; scriptsSessionId: string | null } | undefined;
if (!collection?.scriptsSessionId) throw new Error('这个批次没有已确认的脚本表');
const session = db.prepare('SELECT previewJson FROM live_mixcut_formula_import_sessions WHERE id=?')
  .get(collection.scriptsSessionId) as { previewJson: string } | undefined;
if (!session) throw new Error('脚本表的导入记录不存在');

interface ScriptRow {
  scriptNumber: string; platform: string; targetDurationSec: number | null; bodyText: string; codes: string[];
}
const preview = JSON.parse(session.previewJson) as { rows: Array<{ scriptNumber: string; platform?: string;
  targetDurationSec?: number; bodyText: string; codes: string[] }> };
const scripts: ScriptRow[] = preview.rows.map(row => ({ scriptNumber: String(row.scriptNumber), platform: row.platform ?? '未知',
  targetDurationSec: row.targetDurationSec ?? null, bodyText: row.bodyText,
  codes: row.codes })).slice(0, limit);
if (!scripts.length) throw new Error('脚本表里没有脚本');

const bindings = db.prepare(`SELECT assetId,logicalCode,sourceName FROM live_mixcut_formula_asset_bindings
  WHERE collectionId=? AND excludedReason IS NULL AND logicalCode IS NOT NULL ORDER BY logicalCode,sourceName`)
  .all(collection.id) as Array<{ assetId: string; logicalCode: string; sourceName: string }>;
const assets = new Map<string, { durationSec: number }>();
for (const row of db.prepare('SELECT id,mediaJson FROM live_mixcut_assets WHERE projectId=?').all(project.id) as
  Array<{ id: string; mediaJson: string }>) {
  try {
    const media = JSON.parse(row.mediaJson) as { durationSec?: number };
    if (media.durationSec) assets.set(row.id, { durationSec: media.durationSec });
  } catch { /* 忽略损坏的媒体信息 */ }
}
const speechByAsset = new Map<string, ReturnType<typeof cleanSourceSpeech>>();
for (const row of db.prepare(`SELECT s.assetId,x.resultJson FROM live_mixcut_formula_speech_results x
  JOIN live_mixcut_formula_speech_stages s ON s.id=x.stageId
  WHERE json_extract(x.resultJson,'$.status')='transcribed' ORDER BY x.createdAt`).all() as
  Array<{ assetId: string; resultJson: string }>) {
  const result = JSON.parse(row.resultJson) as { status: string; text: string; words: Array<{ text: string; startUs: number; endUs: number }> };
  if (!result.words?.length) continue;
  speechByAsset.set(row.assetId, cleanSourceSpeech({ text: result.text, words: result.words }));
}

const materialsByCode = new Map<string, SchedulingSlotMaterial>();
for (const binding of bindings) {
  const media = assets.get(binding.assetId);
  if (!media) continue;
  const parsed = parseMaterialFilename(binding.sourceName);
  const isVo = /^VO/i.test(binding.logicalCode);
  const durationUs = Math.round(media.durationSec * 1_000_000);
  const speech = isVo ? speechByAsset.get(binding.assetId) ?? null : null;
  const head = Math.min(2, media.durationSec * 0.2), tail = Math.min(1, media.durationSec * 0.1);
  const file: SchedulingFile = {
    assetId: binding.assetId, contentFingerprint: binding.assetId, fileName: binding.sourceName,
    logicalCode: binding.logicalCode, durationUs,
    usableInUs: speech ? speech.startUs : Math.round(head * 1_000_000),
    usableOutUs: speech ? speech.endUs : durationUs - Math.round(tail * 1_000_000),
    speech: speech ? { text: speech.text, words: speech.words, startUs: speech.startUs, endUs: speech.endUs,
      headCutEndUs: speech.headCutEndUs, tailCutStartUs: speech.tailCutStartUs } : null,
  };
  let material = materialsByCode.get(binding.logicalCode);
  if (!material) {
    material = { logicalCode: binding.logicalCode, kind: binding.logicalCode.replace(/\d+$/, ''), files: [],
      isVo, voLine: parsed.voLine, wide: parsed.wide, wideExperience: parsed.wideExperience };
    materialsByCode.set(binding.logicalCode, material);
  }
  material.files.push(file);
}

function grams(value: string): Set<string> {
  const text = normalizeSpeechText(value);
  const result = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) result.add(text.slice(index, index + 2));
  return result;
}
function overlap(left: string, right: string): number {
  const first = grams(left), second = grams(right);
  let count = 0;
  first.forEach(gram => { if (second.has(gram)) count += 1; });
  return count;
}

const nonVoFiles = [...materialsByCode.values()].filter(material => !material.isVo)
  .flatMap(material => material.files.map(file => ({ file, order: material.logicalCode })));
const talkingFiles = [...materialsByCode.values()].filter(material => material.isVo)
  .map(material => ({ material, file: material.files[0] })).filter(item => item.file && item.material.voLine);

/** 模拟 AI 判断：口播挑本条公式里的，相关素材按文件名重合度排。 */
function judgmentFor(lines: readonly string[], codes: readonly string[]): SchedulingJudgment {
  const whole = lines.join('');
  const own = new Set(codes);
  let bestVo: string | null = null;
  let bestScore = -1;
  for (const item of talkingFiles) {
    if (!own.has(item.material.logicalCode)) continue;
    const score = overlap(whole, item.material.voLine ?? '');
    if (score > bestScore) { bestScore = score; bestVo = item.material.logicalCode; }
  }
  const related = lines.map((line, lineIndex) => ({
    lineIndex,
    assetIds: nonVoFiles.map(entry => ({ assetId: entry.file.assetId, score: overlap(line, entry.file.fileName) }))
      .sort((left, right) => right.score - left.score).map(entry => entry.assetId),
  }));
  return { similar: [], bestVo, related };
}

function materialsFor(codes: readonly string[]): SchedulingSlotMaterial[] {
  const seen = new Set<string>();
  const result: SchedulingSlotMaterial[] = [];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    result.push(materialsByCode.get(code) ?? { logicalCode: code, kind: code.replace(/\d+$/, ''), files: [],
      isVo: /^VO/i.test(code), voLine: null, wide: false, wideExperience: false });
  }
  // 补镜和结尾要从全量素材里挑。
  for (const material of materialsByCode.values()) if (!seen.has(material.logicalCode)) result.push(material);
  return result;
}

function narrationsFor(plan: ReturnType<typeof assignFormulaVoice>): NarrationTake[] {
  return plan.lines.filter(line => !line.fate).map(line => ({
    lineIndex: line.index, text: line.text, durationUs: estimatedSpeechUs(line.text, rate), words: [],
  }));
}

const statistics = {
  scripts: 0,
  byMode: {
    mixed: { missingLines: 0, freeze: 0, overlap: 0, lastLine: 0, other: 0, durations: [] as number[], byPlatform: new Map<string, number[]>() },
    narration: { missingLines: 0, freeze: 0, overlap: 0, lastLine: 0, other: 0, durations: [] as number[], byPlatform: new Map<string, number[]>() },
  },
};
const examples: string[] = [];

for (const script of scripts) {
  statistics.scripts += 1;
  const lines = script.bodyText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) continue;
  const materials = materialsFor(script.codes);
  const judgment = judgmentFor(lines, script.codes);
  for (const mode of ['mixed', 'narration'] as const) {
    const plan = assignFormulaVoice({ script: { scriptNumber: script.scriptNumber, copyIndex: 1, lines, codes: script.codes,
      estimatedDurationSec: script.targetDurationSec }, materials, judgment, voiceMode: mode });
    const timeline = arrangeFormulaTime({ plan, materials, narrations: narrationsFor(plan), judgment,
      scriptNumber: script.scriptNumber, copyIndex: 1 });
    const problems = validateFormulaShortFilm({ plan, timeline, materials });
    const stats = statistics.byMode[mode];
    for (const problem of problems) {
      if (problem.includes('没有配音') || problem.includes('已被原声覆盖，却又配了音')) stats.missingLines += 1;
      else if (problem.includes('静帧')) stats.freeze += 1;
      else if (problem.includes('叠在一起')) stats.overlap += 1;
      else if (problem.includes('最后一句声音')) stats.lastLine += 1;
      else stats.other += 1;
      if (examples.length < 12) examples.push(`${mode} 脚本 ${script.scriptNumber}：${problem}`);
    }
    const duration = timeline.totalDurationUs / 1_000_000;
    stats.durations.push(duration);
    const platform = stats.byPlatform.get(script.platform) ?? [];
    platform.push(duration);
    stats.byPlatform.set(script.platform, platform);
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// 素材标记：全景展示 / 全景体验，直接从文件名读出。
const markerCodes = (pick: (material: SchedulingSlotMaterial) => boolean) => [...materialsByCode.values()]
  .filter(pick).map(material => material.logicalCode).sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
console.log(`全景展示（${markerCodes(material => material.wide).length}）：${markerCodes(material => material.wide).join('、') || '无'}`);
console.log(`全景体验（${markerCodes(material => material.wideExperience).length}）：${markerCodes(material => material.wideExperience).join('、') || '无'}`);

// 脚本表：表头对得上就直接读入，不需要识别。
const workbookRow = db.prepare('SELECT workbookBytes FROM live_mixcut_formula_import_sessions WHERE id=?')
  .get(collection.scriptsSessionId) as { workbookBytes: Buffer | null } | undefined;
if (workbookRow?.workbookBytes) {
  try {
    const preview = await readFormulaWorkbook(workbookRow.workbookBytes, 'scripts');
    console.log(`脚本表：表头对得上，直接读入 ${preview.rows.length} 条；需要识别的表 ${preview.sheets.length - preview.mapping.length} 个`);
  } catch (error) {
    console.log(`脚本表读入失败：${error instanceof Error ? error.message : String(error)}`);
  }
} else console.log('脚本表：这条导入没有保存原表，无法复核直接读入');

console.log(`任务：${project.name}`);
console.log(`批次：${production.name}`);
console.log(`脚本：${statistics.scripts} 条；语速：${rate} 字/秒；素材编号：${materialsByCode.size} 个`);
console.log(`缺素材编号：${scripts.flatMap(script => script.codes).filter(code => !materialsByCode.get(code)?.files.length)
  .filter((code, index, all) => all.indexOf(code) === index).sort().join('、') || '无'}`);
for (const mode of ['mixed', 'narration'] as const) {
  const stats = statistics.byMode[mode];
  console.log(`\n[${mode === 'mixed' ? '原声＋配音' : '统一配音'}] 漏读/重复 ${stats.missingLines} 处；静帧 ${stats.freeze} 处；`
    + `声音重叠 ${stats.overlap} 处；末行不在片尾 ${stats.lastLine} 条；其他 ${stats.other} 处`);
  console.log(`  全部时长中位数：${median(stats.durations).toFixed(1)} 秒`);
  for (const platform of ['淘宝信息流', '抖音', '小红书', '详情页']) {
    const values = stats.byPlatform.get(platform) ?? [];
    if (values.length) console.log(`  ${platform}：${values.length} 条，中位数 ${median(values).toFixed(1)} 秒`);
  }
}
for (const platform of new Set(scripts.map(script => script.platform))) {
  const known = ['淘宝信息流', '抖音', '小红书', '详情页'];
  if (known.includes(platform)) continue;
  const values = statistics.byMode.mixed.byPlatform.get(platform) ?? [];
  console.log(`  ${platform}：${values.length} 条，中位数 ${median(values).toFixed(1)} 秒`);
}
if (examples.length) {
  console.log('\n问题示例：');
  for (const example of examples) console.log(`  - ${example}`);
}
const totalProblems = (['mixed', 'narration'] as const).reduce((sum, mode) => {
  const stats = statistics.byMode[mode];
  return sum + stats.missingLines + stats.freeze + stats.overlap + stats.lastLine + stats.other;
}, 0);
console.log(`\n合计问题：${totalProblems} 处`);
db.close();
process.exitCode = totalProblems ? 1 : 0;
