// 执行清单卡 2 的固定改动（在 copy-and-rename.mjs、generate-schema.mjs 之后跑，只跑一次）。
// 每处改动都按原文精确匹配；有一处对不上就整体停下，不做半截修改。
// 用法：node scripts/live-mixcut-port/card2-edits.mjs
import fs from 'node:fs';

const plans = [];
function edit(file, pairs) { plans.push({ file, pairs }); }
function write(file, text) { plans.push({ file, text }); }
function remove(file) { plans.push({ file, remove: true }); }

// 共享升级设施认识新的范围名。这里只加不减：卡 4 批量恢复以后再删 batch-formula。
edit('lib/schema-upgrade/backup.ts', [
  ["| 'creative-canvas';", "| 'creative-canvas' | 'live-mixcut';"],
  ["  'creative-canvas': 'canvas',\n", "  'creative-canvas': 'canvas',\n  'live-mixcut': 'live-mixcut',\n"],
  ['|script-studio|canvas)-v', '|script-studio|canvas|live-mixcut)-v'],
]);
edit('lib/schema-upgrade/audit.ts', [["  'creative-canvas',\n];", "  'creative-canvas',\n  'live-mixcut',\n];"]]);
edit('lib/schema-upgrade/recovery.ts', [["  'creative-canvas',\n];", "  'creative-canvas',\n  'live-mixcut',\n];"]]);

write('lib/live-mixcut/config.ts', `/** 实拍混剪开关：默认关闭。关闭时不建表、不起后台任务、接口一律返回不可用。 */
export function liveMixcutFeatureEnabled(): boolean {
  return process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE === '1';
}
`);

edit('lib/live-mixcut/runtime-readiness.ts', [
  ['import {\n  batchReadinessUnavailable,', "import { liveMixcutFeatureEnabled } from './config.ts';\nimport {\n  batchReadinessUnavailable,"],
  ['export function getBatchProductionReadiness(): Promise<BatchProductionReadiness> {\n  return checkRuntimeReadiness();\n}',
    `export function getBatchProductionReadiness(): Promise<BatchProductionReadiness> {
  // 开关关闭时不碰数据库，也就不会建表。
  if (!liveMixcutFeatureEnabled()) {
    return Promise.resolve({ available: false, mode: 'compatibility_only', code: 'live_mixcut_disabled',
      message: '实拍混剪尚未启用', appliedVersions: [], targetVersion: 1, checkedAt: new Date().toISOString(), auditId: '' });
  }
  return checkRuntimeReadiness();
}`],
]);

write('lib/live-mixcut/formula/runtime-readiness.ts', `import { getBatchProductionReadiness } from '../runtime-readiness';
import { BatchApiUnavailableError } from '../errors';

/** 实拍混剪只有一条迁移流（../schema.ts），公式能力跟着整个模块的就绪状态走。 */
export async function getFormulaCapability(): Promise<{ available: boolean; message: string; code?: string }> {
  const base = await getBatchProductionReadiness();
  return base.available ? { available: true, message: base.message } : { available: false, code: base.code, message: base.message };
}

export async function assertFormulaApiReady(): Promise<void> {
  const result = await getFormulaCapability();
  if (!result.available) throw new BatchApiUnavailableError(result.code ?? 'live_mixcut_unavailable', result.message);
}
`);

plans.push({ file: 'lib/live-mixcut/formula/execution-gate.ts', transform(text) {
  const importLine = "import { validateFormulaExecutionSchema } from './schema.ts';\n";
  if (!text.includes(importLine)) throw new Error('execution-gate.ts 里没有找到 validateFormulaExecutionSchema 的 import');
  const replaced = text.replace(importLine, "import { liveMixcutFeatureEnabled } from '../config.ts';\n");
  const start = replaced.indexOf('const checks = new WeakMap');
  const end = replaced.indexOf('/** 旧基础库不查询公式表');
  if (start < 0 || end < start) throw new Error('execution-gate.ts 的结构和预期不一致');
  return replaced.slice(0, start)
    + '/** 表结构由 ../schema.ts 的迁移和就绪检查保证，这里只看开关。 */\n'
    + 'export function formulaExecutionAvailable(_db?: Database.Database): boolean {\n  return liveMixcutFeatureEnabled();\n}\n\n'
    + replaced.slice(end);
} });

edit('lib/live-mixcut/bootstrap.ts', [
  ["import { analyzeAssetExecutor, semanticScoreExecutor } from './executors.ts';\n", ''],
  ["import { batchNarrationExecutor } from './narration-executor.ts';\n", ''],
  ["import { getFormulaCapability } from './formula/runtime-readiness';\n", "import { liveMixcutFeatureEnabled } from './config.ts';\n"],
  ['executors: [analyzeAssetExecutor, proxyGenerateExecutor, batchNarrationExecutor, semanticScoreExecutor, batchRenderExecutor, formulaStageExecutor],',
    'executors: [proxyGenerateExecutor, batchRenderExecutor, formulaStageExecutor],'],
  [`  try {
    await assertBatchApiReady();
    // 公式失败只关闭公式任务；普通批量仍由独立基础检查决定是否启动。
    const formula = await getFormulaCapability();
    if (formula.code === 'base_live_mixcut_unavailable') return null;
    return ensureBatchSchedulerStarted();`, `  if (!liveMixcutFeatureEnabled()) return null;
  try {
    await assertBatchApiReady();
    return ensureBatchSchedulerStarted();`],
]);

// 旧的公式迁移流和它的就绪检查，已经并进 lib/live-mixcut/schema.ts。
remove('lib/live-mixcut/formula/schema.ts');
remove('lib/live-mixcut/formula/readiness.ts');

// 先全部核对，再一次性写入。
const results = plans.map(plan => {
  if (plan.remove || plan.text !== undefined) {
    if (plan.remove && !fs.existsSync(plan.file)) throw new Error(`${plan.file} 不存在`);
    return plan;
  }
  let text = fs.readFileSync(plan.file, 'utf8');
  if (plan.transform) return { ...plan, next: plan.transform(text) };
  for (const [from, to] of plan.pairs) {
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`${plan.file}：要替换的原文出现 ${count} 次（应为 1 次）：${from.slice(0, 80)}`);
    text = text.replace(from, to);
  }
  return { ...plan, next: text };
});
for (const plan of results) {
  if (plan.remove) fs.rmSync(plan.file);
  else fs.writeFileSync(plan.file, plan.text ?? plan.next, 'utf8');
  console.log(`${plan.remove ? '删除' : '写入'} ${plan.file}`);
}
