import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanWatchedSources } from './runtime/build-stamp.mjs';

// Runtime data must never be an input to Turbopack's dynamic filesystem tracing.
// Do not copy the repository root: portable installations also contain media,
// Python environments, credentials and previous deliveries there.
export const BUILD_DIRS = ['app', 'components', 'lib', 'public', 'types', 'scripts', 'runtime', 'desktop'];
export const BUILD_FILES = [
  'package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json',
  'postcss.config.mjs', 'next-env.d.ts', 'instrumentation.ts',
];

export function prepareBuildInputs(root, stage) {
  for (const name of [...BUILD_DIRS, ...BUILD_FILES]) {
    const source = path.join(root, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(stage, name), { recursive: true });
  }
  // Hard links avoid duplicating several GB of immutable installed dependencies.
  // Unlike a directory junction, they keep module resolution inside the stage.
  const modules = fs.realpathSync(path.join(root, 'node_modules'));
  const copyDependencies = (source, target, ancestors = new Set()) => {
    const real = fs.realpathSync(source);
    const relative = path.relative(modules, real);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`构建依赖指向 node_modules 外部：${source}`);
    }
    if (fs.statSync(real).isDirectory()) {
      if (ancestors.has(real)) throw new Error(`构建依赖存在循环链接：${source}`);
      const next = new Set(ancestors).add(real);
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(real)) copyDependencies(path.join(real, name), path.join(target, name), next);
    } else {
      try { fs.linkSync(real, target); }
      catch (error) {
        if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
        fs.copyFileSync(real, target);
      }
    }
  };
  copyDependencies(modules, path.join(stage, 'node_modules'));
}

// Turbopack emits hashed external-package junctions, including in standalone.
// They must become real directories before the temporary dependency tree goes away.
export function materializeBuildLinks(stage) {
  // Turbopack resolves these junctions two ways: the top-level ones into
  // `stage/node_modules`, and the standalone ones into
  // `stage/.next/standalone/node_modules`. Both are self-contained inputs of this
  // build, so bound the check by the stage root rather than the top-level tree —
  // anything still outside the stage would embed host content into the artifact.
  const root = fs.realpathSync(stage);
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const source = fs.realpathSync(file);
        const relative = path.relative(root, source);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`构建产物包含指向构建目录之外的链接：${file}`);
        }
        const temporary = `${file}.materializing`;
        fs.cpSync(source, temporary, { recursive: true, dereference: true });
        fs.unlinkSync(file);
        renameBuildDirectory(temporary, file);
      } else if (entry.isDirectory()) visit(file);
    }
  };
  visit(path.join(stage, '.next'));
}

function renameBuildDirectory(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      // Windows scanners can briefly retain handles after the compiler exits.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

export function publishBuild(root, stage, syncAssets) {
  const output = path.join(root, '.next');
  const built = path.join(stage, '.next');
  const previous = path.join(stage, 'previous-next');
  if (!fs.existsSync(path.join(built, 'standalone', 'server.js'))) {
    throw new Error('隔离构建未生成 standalone/server.js，保留原构建');
  }
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
    throw new Error('拒绝替换指向其他目录的 .next 链接');
  }
  const hadPrevious = fs.existsSync(output);
  if (hadPrevious) renameBuildDirectory(output, previous);
  let installed = false;
  try {
    renameBuildDirectory(built, output);
    installed = true;
    syncAssets();
  } catch (error) {
    if (installed) renameBuildDirectory(output, built);
    if (hadPrevious) renameBuildDirectory(previous, output);
    throw error;
  }
}

function runBuild() {
  const root = fs.realpathSync(process.cwd());
  const cache = path.join(root, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  if (fs.realpathSync(cache) !== cache) throw new Error('构建缓存必须位于项目内，不能是目录链接');
  const lock = path.join(cache, 'production-build.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`构建锁损坏，请检查：${lock}`);
    try { process.kill(pid, 0); throw new Error(`已有构建正在运行（PID ${pid}）`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  let stage;
  let published = false;
  const run = (script, args, cwd, env = process.env) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`构建步骤失败：${path.basename(script)}（${result.status ?? result.signal}）`);
  };
  try {
    stage = fs.mkdtempSync(path.join(cache, 'production-build-'));
    const sourceSnapshot = scanWatchedSources(root);
    console.log('正在准备隔离构建目录（仅源码和依赖，不扫描本地素材）…');
    prepareBuildInputs(root, stage);
    // Desktop launchers set DATA_ROOT to the live project. Build workers must
    // use disposable data even when invoked by those launchers.
    run(path.join(stage, 'node_modules/next/dist/bin/next'), ['build'], stage, {
      ...process.env, CREATIVE_STUDIO_DATA_ROOT: stage,
    });
    materializeBuildLinks(stage);
    if (scanWatchedSources(root).newestMs !== sourceSnapshot.newestMs) {
      throw new Error('构建期间源码有更新，保留原产物；请重新构建');
    }
    publishBuild(root, stage, () => run(path.join(root, 'scripts/sync-standalone-assets.mjs'), [], root));
    published = true;
  } finally {
    // Only remove the fresh mkdtemp directory owned by this invocation.
    try {
      if (stage && path.dirname(stage) === cache && path.basename(stage).startsWith('production-build-')) {
        if (!published && fs.existsSync(path.join(stage, 'previous-next'))) {
          console.error(`旧构建回滚受阻，备份保留于：${path.join(stage, 'previous-next')}`);
        } else {
          fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
        }
      }
    } finally { fs.unlinkSync(lock); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runBuild(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
