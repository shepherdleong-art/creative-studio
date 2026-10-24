// 实拍混剪测试搬家脚本（执行清单卡 3）：把 Codex 的公式测试搬成实拍混剪测试。
//   scripts/formula-x.test.ts → scripts/live-mixcut-x.test.ts，原文件删除。
//   - 路径、表名、开关按 rules.mjs 统一替换；
//   - 公式自己的就绪检查已经并入整个模块：checkFormulaReadiness 改成 checkBatchProductionReadiness；
//   - 实拍混剪的数据挂在 live_mixcut_projects 下：就绪检查之后补上测试要用的任务（id 取自原来的 INSERT INTO projects）。
// 不搬：旧迁移流测试、ZIP 导出包测试（见 SKIP）、走旧入口的浏览器测试。只跑一次。
// 用法：node scripts/live-mixcut-port/port-tests.mjs
import fs from 'node:fs';
import path from 'node:path';
import { applyReplacements } from './rules.mjs';

const SKIP = /migration\.test\.ts$|^formula-schema\.test\.ts$|^formula-export-package\.test\.ts$/;
const scripts = path.join(process.cwd(), 'scripts');
const report = { ported: [], skipped: [], needsReview: [] };

// 公式的浏览器测试和 PS866 验收脚本都走旧的批量入口，一并删掉（新入口的浏览器验收由用户手工点，见卡 12）。
for (const name of fs.readdirSync(scripts).filter(file => /^formula-.*\.(playwright\.test\.mjs|playwright\.mjs)$/.test(file)).sort()) {
  fs.rmSync(path.join(scripts, name));
  report.skipped.push(name);
}
// 两个 PS866 只读工具（核查两张表和素材目录、按公式抽帧）留着用，只改路径和名字。
for (const name of ['formula-ps866-audit.ts', 'formula-ps866-contact.ts']) {
  const source = path.join(scripts, name);
  if (!fs.existsSync(source)) continue;
  const target = path.join(scripts, name.replace(/^formula-/, 'live-mixcut-'));
  fs.writeFileSync(target, applyReplacements(fs.readFileSync(source, 'utf8')), 'utf8');
  fs.rmSync(source);
  report.ported.push(path.basename(target));
}

for (const name of fs.readdirSync(scripts).filter(file => /^formula-.*\.test\.ts$/.test(file)).sort()) {
  const source = path.join(scripts, name);
  if (SKIP.test(name)) {
    fs.rmSync(source);
    report.skipped.push(name);
    continue;
  }
  let text = applyReplacements(fs.readFileSync(source, 'utf8'));
  const projectIds = [...text.matchAll(/INSERT INTO projects[^;]*?VALUES\s*([^;]+);/g)]
    .flatMap(match => [...match[1].matchAll(/\(\s*'([^']+)'/g)].map(id => id[1]));
  const usesReadiness = /check(Formula|BatchProduction)Readiness\(/.test(text);
  if (usesReadiness && !projectIds.length) report.needsReview.push(`${name}：调了就绪检查，但没找到 INSERT INTO projects，请手工补 seedLiveMixcutProjects`);
  const lines = text.split('\n').filter(line => !/^\s*(const \{ checkFormulaReadiness \} = await import\(|import \{ checkFormulaReadiness \} from )/.test(line));
  const output = [];
  for (const line of lines) {
    // 两种就绪检查之后都补任务：有的测试只调了批量那一个。INSERT OR IGNORE，补两次也没关系。
    if (!/check(Formula|BatchProduction)Readiness\(/.test(line) || /import|await import\(/.test(line)) { output.push(line); continue; }
    output.push(line.replaceAll('checkFormulaReadiness(', 'checkBatchProductionReadiness('));
    let arg = /check(?:Formula|BatchProduction)Readiness\(([^()]*)\)/.exec(line)?.[1];
    if (!projectIds.length) { report.needsReview.push(`${name}：${line.trim()}`); continue; }
    if (!arg) {
      // 参数里套了括号（如 { db, ...paths(root) }），按变量 db 补，报告里提示核对。
      arg = '{ db }';
      report.needsReview.push(`${name}：按 { db } 补了任务，确认这个测试的库变量确实叫 db`);
    }
    const indent = /^\s*/.exec(line)[0];
    output.push(`${indent}seedLiveMixcutProjects(${arg}, ${JSON.stringify([...new Set(projectIds)]).replaceAll('"', "'")});`);
  }
  text = output.join('\n');
  if (text.includes('seedLiveMixcutProjects(')) text = `import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';\n${text}`;
  const target = path.join(scripts, name.replace(/^formula-/, 'live-mixcut-'));
  if (fs.existsSync(target)) throw new Error(`${target} 已存在，停止`);
  fs.writeFileSync(target, text, 'utf8');
  fs.rmSync(source);
  report.ported.push(path.basename(target));
}

fs.writeFileSync(path.join(scripts, 'live-mixcut-test-helpers.ts'), `import type Database from 'better-sqlite3';

/** 实拍混剪的数据都挂在 live_mixcut_projects（界面上叫"任务"）下；测试在就绪检查建表之后补上要用的任务。 */
export function seedLiveMixcutProjects(options: { db: Database.Database }, ids: string[]): void {
  // 有的测试故意让就绪检查失败（比如开关关闭），这时表不存在，直接跳过。
  if (!options.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'live_mixcut_projects'").get()) return;
  const now = new Date().toISOString();
  const insert = options.db.prepare(\`INSERT OR IGNORE INTO live_mixcut_projects
    (id, name, productName, exportDirName, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)\`);
  for (const id of ids) insert.run(id, \`测试任务 \${id}\`, '测试产品', \`测试任务-\${id}\`, now, now);
}
`, 'utf8');

console.log(`搬了 ${report.ported.length} 个，删了 ${report.skipped.length} 个（${report.skipped.join('、')}）`);
if (report.needsReview.length) {
  console.log('\n需要手工看一眼：');
  for (const item of report.needsReview) console.log(`- ${item}`);
}
