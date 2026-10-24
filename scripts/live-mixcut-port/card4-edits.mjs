// 执行清单卡 4 的固定改动：批量恢复成 main 以后，去掉共享升级设施里的 batch-formula，
// 并把 Codex 写的备份重试测试从公式迁移改成测实拍混剪迁移。只跑一次；原文对不上就整体停下。
// 用法：node scripts/live-mixcut-port/card4-edits.mjs
import fs from 'node:fs';

const plans = [
  ['lib/schema-upgrade/backup.ts', [[" | 'batch-formula'", ''], ["  'batch-formula': 'batch-formula',\n", ''], ['|batch-formula|', '|']]],
  ['lib/schema-upgrade/audit.ts', [["  'batch-formula',\n", '']]],
  ['lib/schema-upgrade/recovery.ts', [["  'batch-formula',\n", '']]],
  ['scripts/schema-upgrade-backup.test.ts', [
    ["import { checkFormulaReadiness } from '../lib/batch-production/formula/readiness.ts';",
      "import { checkBatchProductionReadiness as checkLiveMixcutReadiness } from '../lib/live-mixcut/readiness.ts';"],
    ['checkFormulaReadiness(options)', 'checkLiveMixcutReadiness(options)', 'all'],
    ['.pre-batch-formula-', '.pre-live-mixcut-', 'all'],
    ["scope: 'batch-formula'", "scope: 'live-mixcut'", 'all'],
    ["row.scope === 'batch-formula'", "row.scope === 'live-mixcut'", 'all'],
    ["name='batch_formula_schema_migrations'", "name='live_mixcut_schema_migrations'", 'all'],
    ["?.planningMode, 'semantic');", "?.name, '仍可新建普通批次');"],
    ["'备份未发布时不能启动公式迁移'", "'备份未发布时不能启动实拍混剪迁移'"],
  ]],
];

const results = plans.map(([file, pairs]) => {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to, mode] of pairs) {
    const count = text.split(from).length - 1;
    if (mode === 'all' ? count < 1 : count !== 1) throw new Error(`${file}：要替换的原文出现 ${count} 次：${from.slice(0, 80)}`);
    text = text.split(from).join(to);
  }
  return [file, text];
});
for (const [file, text] of results) {
  fs.writeFileSync(file, text, 'utf8');
  console.log(`写入 ${file}`);
}
