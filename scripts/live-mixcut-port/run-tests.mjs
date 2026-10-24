// 实拍混剪搬家期间的测试运行器：每个测试用独立临时数据根，单个超时 4 分钟。
// 用法：
//   node scripts/live-mixcut-port/run-tests.mjs scripts/live-mixcut-*.test.ts   # 跑指定测试，全过才退出 0
//   node scripts/live-mixcut-port/run-tests.mjs --baseline                     # 批量回归，对照 main（327f531）基线
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// main 上本来就不过的 5 个（过时断言或夹具缺列，和这次搬家无关，不用修）。
const BASELINE_FAILING = new Set([
  'batch-phase-e-narration-gate.test.ts',
  'batch-phase-e-schema.test.ts',
  'batch-phase-e-ui-contract.test.mjs',
  'batch-preparation-workspace.test.mjs',
  'batch-v15-lut-conflict-migration.test.ts',
]);
const BASELINE_PATTERN = /^(batch-.*\.test\.(ts|mjs)|final-edit-bgm-import\.test\.ts|final-edit-alignment\.test\.ts|schema-upgrade-.*\.test\.ts|creative-canvas-bootstrap\.test\.ts)$/;

const args = process.argv.slice(2);
const baseline = args[0] === '--baseline';
const files = baseline
  ? fs.readdirSync('scripts').filter(name => BASELINE_PATTERN.test(name) && !name.includes('playwright')).sort().map(name => `scripts/${name}`)
  : args;
if (!files.length) {
  console.error('没有要跑的测试');
  process.exit(1);
}

const results = [];
for (const file of files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-mixcut-test-'));
  const started = Date.now();
  const run = spawnSync(process.execPath, [file], {
    env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: root },
    encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(root, { recursive: true, force: true });
  const passed = run.status === 0;
  const name = path.basename(file);
  results.push({ name, passed, seconds: Math.round((Date.now() - started) / 1000),
    tail: passed ? '' : `${run.error ? `${run.error.message}\n` : ''}${(run.stderr || run.stdout || '').trim().split('\n').slice(-12).join('\n')}` });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name} ${results.at(-1).seconds}s`);
}

const failed = results.filter(item => !item.passed);
if (!baseline) {
  for (const item of failed) console.log(`\n--- ${item.name}\n${item.tail}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}
const unexpected = results.filter(item => item.passed === BASELINE_FAILING.has(item.name));
for (const item of unexpected) {
  console.log(`\n--- 和基线不一致：${item.name}（基线${BASELINE_FAILING.has(item.name) ? '不过' : '通过'}，现在${item.passed ? '通过' : '不过'}）\n${item.tail}`);
}
console.log(`\n共 ${results.length} 个，${results.length - failed.length} 个通过；和基线不一致 ${unexpected.length} 个`);
process.exit(unexpected.length ? 1 : 0);
