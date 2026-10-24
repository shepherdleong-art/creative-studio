// 实拍混剪剪枝检查（执行清单卡 10）。只读，不删文件。
// 1. 从入口沿 import 走一遍，列出 lib/live-mixcut、components/live-mixcut 里没人用到的文件；
// 2. 列出 app/api/live-mixcut 里界面从没请求过的接口。
// 用法：node scripts/live-mixcut-port/find-unreachable.mjs
import fs from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
}) : [];
const rel = file => path.relative(repo, file).split(path.sep).join('/');

const ROOTS = [
  ...walk(path.join(repo, 'app/live-mixcut')),
  ...walk(path.join(repo, 'app/api/live-mixcut')),
  'instrumentation.ts', 'lib/shutdown.ts', 'app/layout.tsx', 'components/Header.tsx',
  'lib/live-mixcut/bootstrap.ts', 'lib/live-mixcut/config.ts',
].map(file => path.resolve(repo, file)).filter(file => /\.(ts|tsx|mjs|js)$/.test(file) && fs.existsSync(file));

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(repo, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const seen = new Set();
const queue = [...ROOTS];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  if (!/\.(ts|tsx|mjs|js)$/.test(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)) {
    const target = resolveImport(file, match[1] ?? match[2] ?? match[3]);
    if (target) queue.push(target);
  }
}

const moduleFiles = [...walk(path.join(repo, 'lib/live-mixcut')), ...walk(path.join(repo, 'components/live-mixcut'))];
const unreachable = moduleFiles.filter(file => !seen.has(file)).map(rel).sort();
console.log(`== 没人用到的文件（${unreachable.length} 个）`);
for (const file of unreachable) console.log(file);

const uiText = [...walk(path.join(repo, 'components/live-mixcut')), ...walk(path.join(repo, 'app/live-mixcut'))]
  .filter(file => /\.(ts|tsx)$/.test(file)).map(file => fs.readFileSync(file, 'utf8')).join('\n')
  .replace(/\$\{[^}]*\}/g, 'X');
const routes = walk(path.join(repo, 'app/api/live-mixcut')).filter(file => file.endsWith('route.ts'));
const unused = routes.filter(file => {
  const urlPath = rel(path.dirname(file)).replace(/^app/, '');
  const pattern = new RegExp(urlPath.split('/').map(part => /^\[.+\]$/.test(part) ? '[^/\'"`?]+' : part.replace(/[.*+?^${}()|\\]/g, '\\$&')).join('/') + '(?=[\'"`?/]|$)');
  return !pattern.test(uiText);
}).map(rel).sort();
console.log(`\n== 界面没请求过的接口（${unused.length} 个，删之前确认不是被别的接口或服务端调用）`);
for (const file of unused) console.log(file);
