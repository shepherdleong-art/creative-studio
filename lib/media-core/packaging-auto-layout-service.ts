import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataRoot } from '../data-root.ts';
import { spawnHidden, spawnSyncHidden } from '../spawn-hidden.ts';
import type { FinalEditPackagingConfig, PackagingVars } from './packaging-vars.ts';
import { assertSupportedPackagingConfigLayoutVersions } from './packaging-vars.ts';
import { assertSupportedPackagingStickerLayoutVersions } from './packaging-stickers.ts';
import type { PackagingLayoutResolution } from './packaging-auto-layout.ts';
import { buildTimelineVars, PackagingError, resolvePackagingDir, resolvePackagingNode, resolvePackagingTemplateDir } from './packaging-runtime.ts';
import { buildConfigFontFacesCss, safeFontFilename, userFontDir } from './packaging-font.ts';
import { resolvePackagingStickerAssets } from './packaging-sticker-assets.ts';
import type { PackagingPalette } from './packaging-palette.ts';
import { materializePackagingLayoutBundle } from './packaging-layout-manifest.ts';

export type PackagingAutoLayoutFailure = {
  status: 'infeasible' | 'budget_exceeded';
  message?: string;
  conflicts?: unknown;
};
export type PackagingAutoLayoutResult = PackagingLayoutResolution | PackagingAutoLayoutFailure;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

const fileHashCache = new Map<string, string>();
function hashFile(file: string): string {
  const stat = fs.statSync(file);
  const key = `${path.resolve(file)}:${stat.size}:${stat.mtimeMs}`;
  const cached = fileHashCache.get(key);
  if (cached) return cached;
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fileHashCache.set(key, hash);
  return hash;
}

function hashDirectory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result[path.relative(root, absolute).replaceAll(path.sep, '/')] = hashFile(absolute);
    }
  };
  visit(root);
  return result;
}

function killTree(child: { pid?: number; killed: boolean }): void {
  if (!child.pid || child.killed) return;
  try {
    if (process.platform === 'win32') spawnSyncHidden('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { if (!child.killed) try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退出 */ } }
    }
  } catch { /* 已退出 */ }
}

function makeAbortError(): PackagingError {
  const error = new PackagingError('layout_aborted', '自动布局已取消', 409);
  error.name = 'AbortError';
  return error;
}

export async function resolvePackagingAutoLayout(input: {
  config: FinalEditPackagingConfig;
  vars: PackagingVars;
  totalSec: number;
  coverSec: number;
  outputWidth: number;
  outputHeight: number;
  palette?: PackagingPalette | null;
  maxNodes?: number;
  signal?: AbortSignal;
}): Promise<PackagingAutoLayoutResult> {
  assertSupportedPackagingConfigLayoutVersions(input.config);
  assertSupportedPackagingStickerLayoutVersions(input.config.stickers ?? []);
  if (!Number.isSafeInteger(input.outputWidth) || !Number.isSafeInteger(input.outputHeight)
    || input.outputWidth <= 0 || input.outputHeight <= 0 || !(input.totalSec > 0)) {
    throw new PackagingError('layout_output_invalid', '自动布局的输出尺寸或时长无效', 409);
  }
  const packagingDir = resolvePackagingDir();
  const templateDir = resolvePackagingTemplateDir(packagingDir, input.config.template);
  const stickerAssets = resolvePackagingStickerAssets({ packagingDir, template: input.config.template, stickers: input.config.stickers });
  for (const slot of [input.config.pointFont, input.config.titleFont, input.config.subtitleFont]) {
    if (!slot) continue;
    const file = safeFontFilename(slot.file);
    if (!file || !fs.existsSync(path.join(userFontDir(), file))) {
      throw new PackagingError('layout_font_missing', `自动布局字体缺失：${slot.family}`, 409);
    }
  }
  const timelineVars = {
    ...buildTimelineVars({
      vars: input.vars,
      totalSec: input.totalSec,
      coverSec: input.coverSec,
      pointCues: input.config.pointCues ?? [],
      pointCuesMode: input.config.pointCuesMode ?? 'none',
      layouts: input.config.layouts,
      stickers: input.config.stickers,
      stickerDefaults: input.config.stickerDefaults,
      stickerAssets,
      template: input.config.template,
      fonts: { titleFile: input.config.titleFont?.file, subtitleFile: input.config.subtitleFont?.file, pointFile: input.config.pointFont?.file },
    }),
    pointCuesLayoutVersion: input.config.pointCuesLayoutVersion,
    layoutRuntimeBundleVersion: input.config.layoutRuntimeBundleVersion,
  };
  const inputHash = hashJson({ config: input.config, vars: input.vars, totalSec: input.totalSec, coverSec: input.coverSec,
    outputWidth: input.outputWidth, outputHeight: input.outputHeight, palette: input.palette ?? null });
  const chrome = process.env.HYPERFRAMES_BROWSER_PATH || path.join(packagingDir, 'runtime', 'chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
  const geometryManifestHash = hashJson({
    template: hashDirectory(templateDir),
    stickerRuntime: hashFile(path.join(packagingDir, 'stickers', 'runtime.js')),
    autoLayoutRuntime: hashFile(path.join(packagingDir, 'auto-layout', 'runtime.js')),
    layoutService: hashFile(path.join(packagingDir, 'layout-service.mjs')),
    stickerAssets,
    fonts: [input.config.pointFont, input.config.titleFont, input.config.subtitleFont].filter(Boolean).map((slot) => ({
      slot: slot!.family,
      file: slot!.file,
      sha256: hashFile(path.join(userFontDir(), safeFontFilename(slot!.file)!)),
    })),
    chrome: { path: path.basename(chrome), sha256: hashFile(chrome), platform: process.platform, arch: process.arch },
    hyperframes: JSON.parse(fs.readFileSync(path.join(packagingDir, 'node_modules', 'hyperframes', 'package.json'), 'utf8')).version,
  });

  const requestRoot = path.join(dataRoot(), 'storage', 'packaging', 'layout-requests');
  fs.mkdirSync(requestRoot, { recursive: true });
  const requestDir = fs.mkdtempSync(path.join(requestRoot, 'request-'));
  const requestPath = path.join(requestDir, 'request.json');
  const outputPath = path.join(requestDir, 'resolution.json');
  const request = {
    templateDir,
    userFontsDir: userFontDir(),
    vars: timelineVars,
    totalSec: input.totalSec,
    outputWidth: input.outputWidth,
    outputHeight: input.outputHeight,
    palette: input.palette ?? null,
    fontFacesCss: buildConfigFontFacesCss(input.config),
    inputHash,
    runtimeBundleVersion: input.config.layoutRuntimeBundleVersion ?? 2,
    geometryManifestHash,
    maxNodes: input.maxNodes,
  };
  fs.writeFileSync(requestPath, JSON.stringify(request), { encoding: 'utf8', flag: 'wx' });

  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      fs.rmSync(requestDir, { recursive: true, force: true });
      reject(makeAbortError());
      return;
    }
    const child = spawnHidden(resolvePackagingNode(), [path.join(packagingDir, 'layout-service.mjs'), requestPath, outputPath], {
      cwd: packagingDir,
      env: { ...process.env, HYPERFRAMES_BROWSER_PATH: chrome },
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stderrTail = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      fs.rmSync(requestDir, { recursive: true, force: true });
    };
    const finish = (error?: Error, result?: PackagingAutoLayoutResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new PackagingError('layout_resolution_missing', '自动布局未返回有效结果', 409));
    };
    const stop = (error: Error) => { killTree(child); finish(error); };
    const timer = setTimeout(() => stop(new PackagingError('layout_timeout', '自动布局计算超时，请重试', 409)), 120_000);
    const onAbort = () => stop(makeAbortError());
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000); });
    child.on('error', (error) => finish(new PackagingError('layout_spawn_failed', `自动布局进程启动失败：${error.message}`, 409)));
    child.on('close', (code) => {
      try {
        if (!fs.existsSync(outputPath)) throw new PackagingError('layout_failed', `自动布局失败：${stderrTail || '无错误输出'}`, 409);
        const result = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as PackagingAutoLayoutResult & { inputHash?: string; geometryManifestHash?: string };
        const resultMessage = 'message' in result ? result.message : undefined;
        if (code !== 0 && code !== 3) throw new PackagingError('layout_failed', `自动布局失败：${stderrTail.slice(-800) || resultMessage || '未知错误'}`, 409);
        if (result.status === 'resolved') {
          if (result.inputHash !== inputHash || result.geometryManifestHash !== geometryManifestHash) {
            throw new PackagingError('layout_hash_mismatch', '自动布局结果与当前输入或资源不一致', 409);
          }
          materializePackagingLayoutBundle({
            config: input.config,
            outputWidth: input.outputWidth,
            outputHeight: input.outputHeight,
            geometryManifestHash: result.geometryManifestHash,
          });
          finish(undefined, result);
        } else if (result.status === 'infeasible' || result.status === 'budget_exceeded') finish(undefined, result);
        else throw new PackagingError('layout_failed', `自动布局失败：${resultMessage || '未知错误'}`, 409);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
