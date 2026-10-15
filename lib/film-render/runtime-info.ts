import fs from 'node:fs';
import path from 'node:path';
import { resolvePackagingDir, resolvePackagingNode } from '../media-core/packaging-runtime.ts';
import { resolveFfmpegPath, resolveFfprobePath } from '../ffmpeg.ts';
import { FilmRenderError } from './errors.ts';
import { sha256, verifyClassicAssets } from './files.ts';
import { runCaptured } from './process.ts';

export const CLASSIC_HYPERFRAMES_VERSION = '0.8.134';
export function runtimeInfo(packagingDir = resolvePackagingDir(), setupScript = path.join(packagingDir, '../scripts/setup-packaging-runtime.mjs')) {
  const read = (file: string) => {
    if (!fs.existsSync(file)) throw new FilmRenderError('RUNTIME_MISSING', `缺少运行资源: ${file}`, 3);
    return fs.readFileSync(file, 'utf8');
  };
  const declared = JSON.parse(read(path.join(packagingDir, 'package.json'))).dependencies.hyperframes;
  const lockFile = path.join(packagingDir, 'package-lock.json');
  const lock = JSON.parse(read(lockFile));
  const locked = lock.packages['node_modules/hyperframes']?.version;
  const installed = JSON.parse(read(path.join(packagingDir, 'node_modules/hyperframes/package.json'))).version;
  if ([declared, locked, installed, lock.packages['']?.dependencies?.hyperframes].some(v => v !== CLASSIC_HYPERFRAMES_VERSION)) {
    throw new FilmRenderError('RUNTIME_VERSION', `HyperFrames 版本不一致: declared=${declared}, locked=${locked}, installed=${installed}, expected=${CLASSIC_HYPERFRAMES_VERSION}`, 3);
  }
  const dist = path.join(packagingDir, 'node_modules/hyperframes/dist');
  const versions = new Set<string>();
  for (const name of fs.readdirSync(dist).filter(n => n.endsWith('.js'))) {
    for (const match of read(path.join(dist, name)).matchAll(/\bCHROME_VERSION\s*=\s*["']([^"']+)/g)) versions.add(match[1]);
  }
  const chromeVersion = [...versions][0];
  const expectedChrome = /buildId:\s*["']([^"']+)/.exec(read(setupScript))?.[1];
  if (versions.size !== 1 || chromeVersion !== expectedChrome) {
    throw new FilmRenderError('CHROME_VERSION', `Chrome 版本不一致: HyperFrames=${[...versions]}, setup=${expectedChrome}`, 3);
  }
  const chrome = path.join(packagingDir, 'runtime/chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
  const cli = path.join(packagingDir, 'node_modules/hyperframes/bin/hyperframes.mjs');
  for (const file of [chrome, cli, path.join(packagingDir, 'win-hide-spawn.cjs')]) {
    if (!fs.existsSync(file)) throw new FilmRenderError('RUNTIME_MISSING', `缺少运行组件: ${file}`, 3);
  }
  verifyClassicAssets(path.join(packagingDir, 'templates/classic/1'));
  return { packagingDir, node: resolvePackagingNode(), cli, chrome, hyperframesVersion: installed as string,
    chromeVersion, lockSha256: sha256(lockFile) };
}

export async function doctor() {
  const runtime = runtimeInfo();
  if (Number(process.versions.node.split('.')[0]) < 22) throw new FilmRenderError('NODE_VERSION', '需要 Node 22+', 3);
  const warnings: string[] = [];
  const paths = { ffmpeg: resolveFfmpegPath(), ffprobe: resolveFfprobePath() };
  const toolVersion = async (name: string, tool: string, flag: string) => {
    try { return (await runCaptured(tool, [flag], { timeoutMs: 10_000 })).stdout.trim(); }
    catch (error) { throw new FilmRenderError('TOOL_UNAVAILABLE', `${name} 不可用: ${String(error)}`, 3); }
  };
  const nodeVersion = await toolVersion('packaging Node', runtime.node, '--version');
  if (!/^v\d+\./.test(nodeVersion) || Number(nodeVersion.slice(1).split('.')[0]) < 22) {
    throw new FilmRenderError('NODE_VERSION', `包装运行时需要 Node 22+: ${nodeVersion}`, 3);
  }
  const versions: Record<string, string> = { node: nodeVersion, cliNode: process.version };
  for (const [name, tool] of Object.entries(paths)) {
    const requested = process.env[`CREATIVE_STUDIO_${name.toUpperCase()}`];
    if (requested && path.resolve(requested) !== path.resolve(tool)) warnings.push(`${name} 指定路径无效，已回退到 ${tool}`);
    versions[name] = (await toolVersion(name, tool, '-version')).split(/\r?\n/)[0];
  }
  const actualChrome = await toolVersion('Chrome', runtime.chrome, '--version');
  if (!actualChrome.includes(runtime.chromeVersion)) throw new FilmRenderError('CHROME_VERSION', `Chrome 可执行文件版本不符: ${actualChrome}`, 3);
  return { ok: true, runtime, paths, versions: { ...versions, chrome: actualChrome }, warnings };
}
