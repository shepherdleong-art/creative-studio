#!/usr/bin/env node
// 包装运行时（packaging/）装配脚本。
//
// 背景：packaging 目录不进 git（.gitignore 排除 runtime/node_modules/renders 等），
// 开发仓库需要本脚本把运行时装配到仓库根 packaging/。
//
// 装配来源（优先级）：
//   1. --from 指定目录；
//   2. 0.7.0 免安装版的 .next/standalone/packaging（原装完整运行时，默认）；
//   3. 0.5.2 包装测试版的 packaging（旧版兜底，classic/1 缺失时走开源下载补全）。
//
// 装配内容：整树复制（templates/fonts/film-builders/package-video.mjs/win-hide-spawn.cjs/
// package.json/package-lock.json/film-runtime.json/node_modules/runtime），
// 复制后按 lib/film-render/runtime-info.ts、files.ts 的契约逐项校验：
//   - hyperframes 版本 = 0.8.134（不匹配则在目标目录重装）
//   - film-runtime.json 契约字段
//   - chrome-headless-shell 可执行且版本 = 152.0.7977.30
//   - templates/classic/1 冻结资产 SHA256
//
// 用法：
//   node scripts/setup-packaging-runtime.mjs [--from <参考packaging目录>] [--force]

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'packaging');

// ---- 契约常量（与 lib/film-render/runtime-info.ts、files.ts 保持一致，改动需双侧同步）----
const HYPERFRAMES_VERSION = '0.8.134';
const CHROME_VERSION = '152.0.7977.30';
const CLASSIC_FROZEN_ASSETS = {
  'assets/fonts/SourceHanSansCN-VF.ttf': '25a01e41b5cc99893eb35a6cd2cc7611841dc19eb03cbaf7f0c1de8210f2ba0b',
  'assets/scripts/gsap.min.js': 'c174bfce53a729418d57a8ad8625e7247c793a22fef8e2851e3cfa3de9cd8280',
};
// 默认参考源：0.7.0 免安装版 standalone 内的原装包装运行时
const DEFAULT_REFERENCE = 'H:\\AI工作台\\创意工作台-0.7.0-免安装版-20261019\\.next\\standalone\\packaging';
// 整树复制时的排除项（渲染产物、演示输出、扫描缓存不进仓库运行时）
const EXCLUDE_NAMES = new Set(['renders', 'mockups', '.font-scan-cache.json', '_palette-lab.cjs', '_t-verify.mjs']);
// classic/1 冻结资产的开源下载候选（仅参考源缺失时的最后兜底；校验哈希后才接受）
const CLASSIC_DOWNLOAD_CANDIDATES = {
  'assets/fonts/SourceHanSansCN-VF.ttf': [
    'https://raw.githubusercontent.com/adobe-fonts/source-han-sans/release/Variable/TTF/SourceHanSansCN-VF.ttf',
  ],
  'assets/scripts/gsap.min.js': [
    'https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/gsap.min.js',
  ],
};

const report = { copied: [], installed: [], skipped: [], gaps: [] };

function parseArgs(argv) {
  const args = { from: '', force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') args.from = argv[++i] ?? '';
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 整树复制（跳过 EXCLUDE_NAMES 与 _proto-* 演示模板之外均保留；目标已存在且非 force 则跳过）。 */
function copyTree(source, target, force, rel = '') {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (/^demo-/.test(entry.name)) continue;
      if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
      copyTree(from, to, force, relPath);
    } else if (entry.isFile()) {
      if (fs.existsSync(to) && !force) { report.skipped.push(relPath); continue; }
      fs.copyFileSync(from, to);
      report.copied.push(relPath);
    }
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function npmInstall() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: TARGET, stdio: 'inherit' }).status;
}

async function tryDownload(url) {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reference = args.from || DEFAULT_REFERENCE;
  console.log(`[setup-packaging] 目标目录: ${TARGET}`);
  console.log(`[setup-packaging] 参考源: ${reference}${fs.existsSync(reference) ? '' : '（不存在！）'}`);

  fs.mkdirSync(TARGET, { recursive: true });

  // 1. 整树复制（node_modules/runtime 也一并复制：原装版本与契约一致，免重装）
  if (fs.existsSync(reference)) {
    copyTree(reference, TARGET, args.force);
  } else {
    report.gaps.push(`参考源不存在：${reference}，仅装配可生成部分`);
  }

  // 2. package.json / film-runtime.json 契约补齐（源缺失时也能生成正确契约）
  if (!fs.existsSync(path.join(TARGET, 'package.json'))) {
    writeJson(path.join(TARGET, 'package.json'), {
      name: 'creative-studio-packaging-runtime',
      private: true,
      version: '1.0.0',
      description: '创意工作台包装运行时（由 scripts/setup-packaging-runtime.mjs 装配，勿手动编辑）',
      dependencies: { hyperframes: HYPERFRAMES_VERSION },
    });
    report.installed.push('package.json（按契约生成）');
  }
  const filmRuntimePath = path.join(TARGET, 'film-runtime.json');
  const filmRuntime = fs.existsSync(filmRuntimePath) ? JSON.parse(fs.readFileSync(filmRuntimePath, 'utf8')) : null;
  if (!filmRuntime || filmRuntime.schemaVersion !== 1 || filmRuntime.hyperframesVersion !== HYPERFRAMES_VERSION || filmRuntime.chromeVersion !== CHROME_VERSION) {
    writeJson(filmRuntimePath, { schemaVersion: 1, hyperframesVersion: HYPERFRAMES_VERSION, chromeVersion: CHROME_VERSION });
    report.installed.push('film-runtime.json（按契约生成）');
  } else {
    report.skipped.push('film-runtime.json');
  }

  // 3. hyperframes 版本校验：复制来的 node_modules 不匹配才重装
  const installedPkg = path.join(TARGET, 'node_modules', 'hyperframes', 'package.json');
  const installedVersion = fs.existsSync(installedPkg) ? JSON.parse(fs.readFileSync(installedPkg, 'utf8')).version : null;
  if (installedVersion === HYPERFRAMES_VERSION) {
    report.skipped.push(`hyperframes@${HYPERFRAMES_VERSION}（复制自参考源）`);
  } else {
    console.log(`[setup-packaging] hyperframes 版本不符（当前 ${installedVersion ?? '缺失'}），重装 ${HYPERFRAMES_VERSION} ...`);
    if (npmInstall() === 0) report.installed.push(`hyperframes@${HYPERFRAMES_VERSION}`);
    else report.gaps.push('hyperframes npm install 失败，请检查网络后重跑');
  }

  // 4. chrome-headless-shell 验证
  const chromeExe = path.join(TARGET, 'runtime', 'chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
  if (fs.existsSync(chromeExe)) {
    const probe = spawnSync(chromeExe, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const version = (probe.stdout || '').trim();
    if (version.includes(CHROME_VERSION)) report.installed.push(`chrome-headless-shell ${CHROME_VERSION}（已验证）`);
    else report.gaps.push(`chrome-headless-shell 版本不符: "${version || '无法执行'}"，期望包含 ${CHROME_VERSION}`);
  } else {
    report.gaps.push('chrome-headless-shell 缺失（参考源未提供）');
  }

  // 5. classic/1 冻结资产校验（复制自 0.7.0 源必然匹配；缺失时走开源下载兜底）
  const classicDir = path.join(TARGET, 'templates', 'classic', '1');
  const missingClassic = [];
  for (const [relative, expected] of Object.entries(CLASSIC_FROZEN_ASSETS)) {
    const target = path.join(classicDir, relative);
    if (fs.existsSync(target) && sha256(target) === expected) { report.skipped.push(`templates/classic/1/${relative}（哈希匹配）`); continue; }
    let recovered = false;
    for (const url of CLASSIC_DOWNLOAD_CANDIDATES[relative] ?? []) {
      const buffer = await tryDownload(url);
      if (!buffer) continue;
      if (createHash('sha256').update(buffer).digest('hex') !== expected) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
      report.installed.push(`templates/classic/1/${relative}（开源下载，哈希匹配）`);
      recovered = true;
      break;
    }
    if (!recovered) missingClassic.push(relative);
  }
  if (missingClassic.length > 0) {
    report.gaps.push(`classic/1 冻结资产缺失: ${missingClassic.join(', ')} —— film-render 固定渲染管线暂不可用；overlay 包装管线不受影响`);
  } else if (!fs.existsSync(path.join(classicDir, 'template.json'))) {
    // 资产齐了但缺清单时补齐（files.ts 校验 id/version/assets 三项一致）
    writeJson(path.join(classicDir, 'template.json'), { id: 'classic', version: '1', assets: CLASSIC_FROZEN_ASSETS });
    report.installed.push('templates/classic/1/template.json');
  } else {
    report.skipped.push('templates/classic/1/template.json');
  }

  // 6. 报告
  console.log('\n========== 装配报告 ==========');
  for (const [label, items] of [['已复制', report.copied], ['已装配', report.installed], ['已跳过/已校验', report.skipped]]) {
    if (items.length) console.log(`${label} (${items.length}):\n  - ${items.slice(0, 20).join('\n  - ')}${items.length > 20 ? `\n  ... 等 ${items.length} 项` : ''}`);
  }
  if (report.gaps.length) {
    console.log(`缺口:\n  - ${report.gaps.join('\n  - ')}`);
    process.exitCode = 2; // 部分完成：缺口需人工处理
  } else {
    console.log('缺口: 无（包装运行时完整，含 classic 固定渲染管线）');
  }
}

main().catch((error) => {
  console.error(`[setup-packaging] 装配失败: ${error.stack || error}`);
  process.exit(1);
});