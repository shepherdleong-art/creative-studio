/**
 * 手动验收：拿真实批次里的几条脚本各跑一次 AI 判断，把三样结果打出来给人看。
 * 真实库只读打开，先复制到临时目录再升级和写缓存，不写回真实库。
 *
 * 用法：node scripts/live-mixcut-judgment.acceptance.ts [--batch <collectionId>] [--provider gemini] [--scripts 1,9,245] [--keep] [--dry]
 * 会真实调用文本模型（每条脚本一次，格式不对最多重试一次）；加 --dry 只检查输入、不调模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import Database from 'better-sqlite3';

// lib/script-providers 里还有不带扩展名的相对导入，按测试同样的办法补上。
register('./typescript-extension-loader.mjs', import.meta.url);

interface BindingRow {
  logicalCode: string | null;
  assetId: string;
  contentFingerprint: string;
  sourceName: string;
  excludedReason: string | null;
}
interface ScriptRow { id: string; title: string; bodyText: string; externalSourceId: string }

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] ?? null : null;
}

const realRoot = process.env.CREATIVE_STUDIO_DATA_ROOT ?? process.cwd();
const sourcePath = path.join(realRoot, 'data', 'workbench.db');
if (!fs.existsSync(sourcePath)) throw new Error(`找不到真实数据库：${sourcePath}`);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-judgment-check-'));
fs.mkdirSync(path.join(tempRoot, 'data'), { recursive: true });
const copyPath = path.join(tempRoot, 'data', 'workbench.db');
{
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  source.prepare('VACUUM INTO ?').run(copyPath);
  source.close();
}
process.env.CREATIVE_STUDIO_DATA_ROOT = tempRoot;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';

const db = new Database(copyPath);
db.pragma('foreign_keys=ON');

try {
  const providerId = arg('provider') ?? 'gemini';
  const wanted = (arg('scripts') ?? '1,9,245').split(',').map(value => value.trim()).filter(Boolean);
  const titles = wanted.map(value => `脚本 ${value}`);
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { judgeFormulaFilm } = await import('../lib/live-mixcut/formula/judgment.ts');
  const { parseMaterialFilename } = await import('../lib/live-mixcut/formula/parse.ts');
  const { resolveTextJsonModel } = await import('../lib/media-core/adapters/text-json.ts');

  const readiness = await checkBatchProductionReadiness({ db, ...schemaUpgradeRuntimePaths(tempRoot) });
  if (readiness.available !== true) {
    throw new Error(`实拍混剪不可用：${readiness.code} ${'message' in readiness ? readiness.message : ''}`);
  }

  // 找同时含有这些脚本的最新批次。
  const collections = db.prepare('SELECT id, projectId, scriptsSessionId, createdAt FROM live_mixcut_formula_collections ORDER BY createdAt DESC').all() as
    Array<{ id: string; projectId: string; scriptsSessionId: string | null; createdAt: string }>;
  const forcedBatch = arg('batch');
  let chosen: { id: string; projectId: string; scripts: ScriptRow[] } | null = null;
  for (const collection of collections) {
    if (forcedBatch && collection.id !== forcedBatch) continue;
    if (!collection.scriptsSessionId) continue;
    const scripts = db.prepare('SELECT id, title, bodyText, externalSourceId FROM live_mixcut_scripts WHERE externalSourceId LIKE ? AND title IN (' +
      titles.map(() => '?').join(',') + ') ORDER BY CAST(substr(title, 4) AS INTEGER)')
      .all(`formula:${collection.scriptsSessionId}:%`, ...titles) as ScriptRow[];
    if (scripts.length === titles.length) { chosen = { id: collection.id, projectId: collection.projectId, scripts }; break; }
  }
  if (!chosen) throw new Error(`没有找到同时含有 ${titles.join('、')} 的批次`);
  console.log(`批次 ${chosen.id}（${chosen.scripts.length} 条脚本），模型 ${providerId}`);

  const bindings = db.prepare('SELECT logicalCode, assetId, contentFingerprint, sourceName, excludedReason FROM live_mixcut_formula_asset_bindings WHERE collectionId=?')
    .all(chosen.id) as BindingRow[];
  // 原声实际说的话：真实批次里已经存过的转写结果（按素材取最新一条转录成功的）。
  const transcriptRows = db.prepare(`SELECT r.resultJson FROM live_mixcut_formula_speech_stages s
    JOIN live_mixcut_formula_speech_results r ON r.stageId = s.id WHERE s.assetId=? ORDER BY r.createdAt DESC`);
  const transcriptOf = (assetId: string): string | null => {
    for (const row of transcriptRows.all(assetId) as Array<{ resultJson: string }>) {
      try {
        const parsed = JSON.parse(row.resultJson) as { status?: string; text?: string };
        if (parsed.status === 'transcribed' && parsed.text) return parsed.text;
      } catch { /* 坏行跳过 */ }
    }
    return null;
  };

  const voiceOvers = new Map<string, { logicalCode: string; plannedLine: string | null; speechText: string }>();
  let voiceOverMissing = 0;
  for (const binding of bindings) {
    const code = binding.logicalCode;
    if (!code || !/^VO/i.test(code) || binding.excludedReason) continue;
    if (voiceOvers.has(code)) continue;
    const speechText = transcriptOf(binding.assetId);
    if (!speechText) { voiceOverMissing += 1; continue; }
    voiceOvers.set(code, { logicalCode: code, plannedLine: parseMaterialFilename(binding.sourceName).voLine, speechText });
  }
  const seenAssets = new Set<string>();
  const materials = bindings.filter(binding => {
    if (!binding.logicalCode || /^VO/i.test(binding.logicalCode) || binding.excludedReason) return false;
    if (seenAssets.has(binding.assetId)) return false;
    seenAssets.add(binding.assetId);
    return true;
  }).map(binding => ({ logicalCode: binding.logicalCode!, assetId: binding.assetId, fileName: binding.sourceName, description: null }));
  console.log(`口播 ${voiceOvers.size} 段${voiceOverMissing ? `（另有 ${voiceOverMissing} 段没有转写结果，没给模型）` : ''}，非口播素材 ${materials.length} 段；真实批次还没有画面描述，排序只依据文件名。\n`);

  // 判断要按行排 20 个素材，回复比一般脚本调用长，单独放宽输出上限和超时。
  const base = await resolveTextJsonModel(providerId, { projectId: chosen.projectId, refType: 'live_mixcut_judgment_check', refId: chosen.id },
    { maxTokens: 16384, timeoutMs: 180_000 });
  console.log(`模型：${base.name} · ${base.model}\n`);
  const nameOf = new Map(materials.map(item => [item.assetId, item.fileName]));
  const speechOf = new Map([...voiceOvers.values()].map(item => [item.logicalCode, item.speechText]));
  let totalCalls = 0;
  if (process.argv.includes('--probe')) {
    // 排查格式用：只调一次模型，把原始回复或异常打出来，不做判断、不写缓存。
    const { formulaJudgmentPrompt } = await import('../lib/live-mixcut/formula/judgment.ts');
    const script = chosen.scripts[0];
    const lines = script.bodyText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const prompt = formulaJudgmentPrompt({ script: { lines }, voiceOvers: [...voiceOvers.values()], materials });
    console.log(`提示词 ${Buffer.byteLength(prompt.systemPrompt) + Buffer.byteLength(prompt.userPrompt)} 字节，调一次模型…`);
    try {
      const value = await base.complete({ ...prompt, signal: new AbortController().signal });
      console.log(`返回：${JSON.stringify(value).slice(0, 4000)}`);
    } catch (error) {
      console.log(`异常：${error instanceof Error ? error.message.slice(0, 4000) : String(error)}`);
    }
    console.log(`\n--probe 结束，共 1 次调用。临时库在 ${tempRoot}${arg('keep') ? '' : '（结束后删除）'}`);
    if (!arg('keep')) fs.rmSync(tempRoot, { recursive: true, force: true });
  } else {
  const dry = process.argv.includes('--dry');
  if (dry) {
    for (const script of chosen.scripts) {
      const lines = script.bodyText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const input = { script: { lines }, voiceOvers: [...voiceOvers.values()], materials };
      const bytes = Buffer.byteLength(JSON.stringify(input));
      console.log(`=== ${script.title}：${lines.length} 行，输入约 ${bytes} 字节（不调用模型）===`);
    }
  }

  for (const script of dry ? [] : chosen.scripts) {
    const lines = script.bodyText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    let calls = 0;
    const model = {
      ...base,
      complete: async (input: { systemPrompt: string; userPrompt: string; signal: AbortSignal }) => {
        calls += 1;
        return base.complete(input);
      },
    };
    const startedAt = Date.now();
    const view = await judgeFormulaFilm(db, chosen.projectId, { script: { lines }, voiceOvers: [...voiceOvers.values()], materials },
      model, new AbortController().signal);
    totalCalls += calls;
    console.log(`=== ${script.title}：${lines.length} 行，${calls} 次调用，${((Date.now() - startedAt) / 1000).toFixed(1)} 秒，${view.cached ? '读缓存' : '新判断'} ===`);
    lines.forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
    console.log('  相近口播：');
    if (!view.judgment.similar.length) console.log('    （没有判断出意思相近的行）');
    for (const item of view.judgment.similar) {
      console.log(`    第 ${item.lineIndex + 1} 行 ← ${item.logicalCode}（原声：「${speechOf.get(item.logicalCode) ?? ''}」）`);
    }
    console.log(`  最搭口播：${view.judgment.bestVo ? `${view.judgment.bestVo}（原声：「${speechOf.get(view.judgment.bestVo) ?? ''}」）` : '无'}`);
    console.log('  每行相关素材（前 5）：');
    for (const item of [...view.judgment.related].sort((a, b) => a.lineIndex - b.lineIndex)) {
      const names = item.assetIds.slice(0, 5).map(assetId => nameOf.get(assetId) ?? assetId);
      console.log(`    第 ${item.lineIndex + 1} 行：${names.join('、') || '（空）'}${item.assetIds.length > 5 ? ` 等 ${item.assetIds.length} 个` : ''}`);
    }
    console.log('');
  }
  console.log(dry ? '\n输入检查完成，没有调用模型。' : `合计模型调用 ${totalCalls} 次。`);
  console.log(`临时库在 ${tempRoot}${arg('keep') ? '' : '（结束后删除）'}`);
  if (!arg('keep')) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
} finally {
  db.close();
}
