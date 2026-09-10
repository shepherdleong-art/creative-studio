#!/usr/bin/env node
// 构建戳：让桌面版启动脚本识别「源码比 standalone 构建产物新」，无需手动 -Rebuild。
//
// 用法：
//   node scripts/runtime/build-stamp.mjs write <stampFile> [root]   # 构建末尾写戳
//   node scripts/runtime/build-stamp.mjs check <stampFile> [root]   # 启动前比对
//
// check 退出码：0=产物新鲜；1=源码更新或戳缺失/损坏（重建即可）；
//               2=依赖清单（package.json/package-lock.json）更新（先 npm ci 再重建）。
// 戳记录的是构建时刻受监视源码的最新 mtime（而非写入时刻），这样即使构建期间
// 有文件被保存，下次启动也只会重建一次，不会反复误报。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 影响 standalone 产物的源码目录（相对仓库根）。 */
export const WATCHED_DIRS = ['app', 'components', 'lib', 'runtime', 'public', 'types'];
/** 影响产物的根级文件；scripts 里只有同步脚本本身影响产物内容。 */
export const WATCHED_FILES = [
  'next.config.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'postcss.config.mjs',
  'scripts/sync-standalone-assets.mjs',
];
/** 这些文件更新时必须先 npm ci 再重建，否则构建会沿用旧依赖。 */
export const DEPS_FILES = ['package.json', 'package-lock.json'];

/** 扫描受监视路径，返回最新 mtime（毫秒）。目录/文件不存在时跳过（夹具环境容忍）。 */
export function scanWatchedSources(root) {
  let newestMs = 0;
  let newestPath = '';
  let newestDepsMs = 0;
  let newestDepsPath = '';
  const track = (abs, rel) => {
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) track(join(abs, entry.name), `${rel}/${entry.name}`);
        else if (entry.isFile()) trackFile(join(abs, entry.name), `${rel}/${entry.name}`);
      }
      return;
    }
    trackFile(abs, rel);
  };
  const trackFile = (abs, rel) => {
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return;
    }
    if (stat.mtimeMs > newestMs) {
      newestMs = stat.mtimeMs;
      newestPath = rel;
    }
    if (DEPS_FILES.includes(rel) && stat.mtimeMs > newestDepsMs) {
      newestDepsMs = stat.mtimeMs;
      newestDepsPath = rel;
    }
  };
  for (const dir of WATCHED_DIRS) {
    const abs = join(root, dir);
    if (existsSync(abs)) track(abs, dir);
  }
  for (const file of WATCHED_FILES) {
    const abs = join(root, file);
    if (existsSync(abs)) trackFile(abs, file);
  }
  return { newestMs, newestPath, newestDepsMs, newestDepsPath };
}

/** 构建成功后写戳（由 sync-standalone-assets.mjs 在产物清理校验通过后调用）。 */
export function writeBuildStamp(root, stampFile) {
  const scan = scanWatchedSources(root);
  const stamp = {
    version: 1,
    newestSourceMs: scan.newestMs,
    newestSourcePath: scan.newestPath,
    newestDepsMs: scan.newestDepsMs,
    writtenAt: new Date().toISOString(),
  };
  mkdirSync(dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, `${JSON.stringify(stamp)}\n`);
  return stamp;
}

/** 启动前比对。返回 { status: 'fresh' | 'stale-source' | 'stale-deps', reason }。 */
export function checkBuildStamp(root, stampFile) {
  if (!existsSync(stampFile)) return { status: 'stale-source', reason: '构建戳缺失（上次构建未写戳）' };
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
  } catch {
    return { status: 'stale-source', reason: '构建戳损坏' };
  }
  if (!stamp || stamp.version !== 1 || typeof stamp.newestSourceMs !== 'number') {
    return { status: 'stale-source', reason: '构建戳版本不识别' };
  }
  const scan = scanWatchedSources(root);
  if (scan.newestDepsMs > (stamp.newestDepsMs ?? 0)) {
    return { status: 'stale-deps', reason: `依赖清单已更新: ${scan.newestDepsPath}` };
  }
  if (scan.newestMs > stamp.newestSourceMs) {
    return { status: 'stale-source', reason: `源码已更新: ${scan.newestPath}` };
  }
  return { status: 'fresh', reason: '' };
}

function main(argv) {
  const [command, stampFile, root = process.cwd()] = argv;
  if ((command !== 'write' && command !== 'check') || !stampFile) {
    console.error('用法: build-stamp.mjs <write|check> <stampFile> [root]');
    process.exit(64);
  }
  if (command === 'write') {
    const stamp = writeBuildStamp(root, stampFile);
    console.log(`构建戳已写入: ${stampFile}（最新源码: ${stamp.newestSourcePath || '无受监视文件'}）`);
    return;
  }
  const result = checkBuildStamp(root, stampFile);
  if (result.status === 'fresh') {
    process.exit(0);
  }
  console.log(result.reason);
  process.exit(result.status === 'stale-deps' ? 2 : 1);
}

const invokedAs = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
if (invokedAs && fileURLToPath(import.meta.url).replace(/\\/g, '/') === invokedAs) {
  main(process.argv.slice(2));
}
