// 实拍混剪搬家脚本（执行清单卡 2）：把批量生产（含 Codex 的公式代码）复制成实拍混剪模块，并做机械替换。
// 只跑一次；目标目录已存在就退出，不覆盖。
// 用法：node scripts/live-mixcut-port/copy-and-rename.mjs [--out <目录>]
//   --out 只用于试跑：把复制结果写到别的目录，仓库本身不动。
import fs from 'node:fs';
import path from 'node:path';
import { applyReplacements } from './rules.mjs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const repo = process.cwd();
const out = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : repo;

const TREES = [
  ['lib/batch-production', 'lib/live-mixcut'],
  ['components/batch-production', 'components/live-mixcut'],
  ['app/api/batch-production', 'app/api/live-mixcut'],
];



const TEXT_FILE = /\.(ts|tsx|mts|mjs|js)$/;

function copyTree(fromRel, toRel, stats) {
  const from = path.join(repo, fromRel);
  const to = path.join(out, toRel);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(path.join(fromRel, entry.name), path.join(toRel, entry.name), stats);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!TEXT_FILE.test(entry.name)) {
      fs.copyFileSync(source, target);
      stats.copied++;
      continue;
    }
    const text = applyReplacements(fs.readFileSync(source, 'utf8'), () => { stats.replaced++; });
    fs.writeFileSync(target, text, 'utf8');
    stats.copied++;
  }
}

for (const [, toRel] of TREES) {
  if (fs.existsSync(path.join(out, toRel))) {
    console.error(`${toRel} 已存在，停止。要重跑先删掉它。`);
    process.exit(1);
  }
}
const stats = { copied: 0, replaced: 0 };
for (const [fromRel, toRel] of TREES) copyTree(fromRel, toRel, stats);
console.log(`复制 ${stats.copied} 个文件，替换 ${stats.replaced} 处 → ${out}`);
