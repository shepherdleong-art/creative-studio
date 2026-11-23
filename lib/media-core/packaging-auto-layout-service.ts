import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataRoot } from '../data-root.ts';
import { spawnHidden, spawnSyncHidden } from '../spawn-hidden.ts';
import type { FinalEditPackagingConfig, PackagingVars } from './packaging-vars.ts';
import { assertSupportedPackagingConfigLayoutVersions } from './packaging-vars.ts';
import { assertSupportedPackagingStickerLayoutVersions, STICKER_AUTO_MIN_BODY_FRAMES } from './packaging-stickers.ts';
import type { PackagingLayoutResolution } from './packaging-auto-layout.ts';
import { buildTimelineVars, PackagingError, resolvePackagingDir, resolvePackagingNode } from './packaging-runtime.ts';
import { buildConfigFontFacesCss } from './packaging-font.ts';
import { readPackagingStickerPlanningAssets, resolvePackagingStickerAssets } from './packaging-sticker-assets.ts';
import { planPackagingStickerAutoLayout } from './packaging-sticker-planner.ts';
import type { PackagingPalette } from './packaging-palette.ts';
import { materializePackagingLayoutBundle, packagingLayoutDependenciesRoot, packagingLayoutEngineExecutable } from './packaging-layout-manifest.ts';

export type PackagingAutoLayoutFailure = {
  status: 'infeasible' | 'budget_exceeded';
  message?: string;
  conflicts?: unknown;
};
export type PackagingAutoLayoutResult = PackagingLayoutResolution | PackagingAutoLayoutFailure;

export async function resolveInitialPackagingStickers(
  input: Parameters<typeof resolvePackagingAutoLayout>[0] & { bodyFrames: number },
  resolveLayout = resolvePackagingAutoLayout,
): Promise<FinalEditPackagingConfig | undefined> {
  if (!input.config.enabled || input.config.stickers !== undefined || input.bodyFrames < STICKER_AUTO_MIN_BODY_FRAMES) return undefined;
  const stickers = planPackagingStickerAutoLayout({
    bodyFrames: input.bodyFrames,
    template: input.config.template,
    assets: readPackagingStickerPlanningAssets(resolvePackagingDir()),
    animation: input.config.stickerDefaults?.animation ?? 'follow-template',
    autoGroupId: `auto_${randomUUID()}`,
    random: Math.random,
    createId: () => `s_${randomUUID()}`,
    outputWidth: input.outputWidth,
    outputHeight: input.outputHeight,
  });
  if (!stickers) throw new PackagingError('sticker_auto_pool_invalid', '当前正文或画幅无法生成基础贴纸', 409);
  const config = { ...input.config, stickers, layoutRuntimeBundleVersion: 2 as const, layoutResolution: undefined };
  const resolution = await resolveLayout({ ...input, config });
  if (resolution.status !== 'resolved') {
    throw new PackagingError('layout_unresolved', ('message' in resolution && resolution.message) || '基础贴纸自动布置未完成', 409);
  }
  return { ...config, layoutResolution: resolution };
}

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

export function packagingAutoLayoutInputHash(input: {
  config: FinalEditPackagingConfig; vars: PackagingVars; totalSec: number; coverSec: number;
  outputWidth: number; outputHeight: number; palette?: PackagingPalette | null;
}): string {
  return hashJson({ config: { ...input.config, layoutResolution: undefined,
    stickers: input.config.stickers ?? [], layouts: input.config.layouts ?? {}, pointCues: input.config.pointCues ?? [],
    pointCuesEdited: input.config.pointCuesEdited === true }, vars: input.vars, totalSec: input.totalSec,
    coverSec: input.coverSec, outputWidth: input.outputWidth, outputHeight: input.outputHeight, palette: input.palette ?? null });
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
  if (input.signal?.aborted) throw makeAbortError();
  const { bundleDir, manifest } = await materializePackagingLayoutBundle(input);
  const templateDir = path.join(bundleDir, 'templates', input.config.template);
  const stickerAssets = resolvePackagingStickerAssets({ packagingDir: bundleDir, template: input.config.template, stickers: input.config.stickers });
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
  const inputHash = packagingAutoLayoutInputHash(input);
  const chrome = packagingLayoutEngineExecutable(manifest);
  const geometryManifestHash = manifest.geometryManifestHash;

  const requestRoot = path.join(dataRoot(), 'storage', 'packaging', 'layout-requests');
  fs.mkdirSync(requestRoot, { recursive: true });
  const requestDir = fs.mkdtempSync(path.join(requestRoot, 'request-'));
  const requestPath = path.join(requestDir, 'request.json');
  const outputPath = path.join(requestDir, 'resolution.json');
  const request = {
    templateDir,
    userFontsDir: path.join(bundleDir, 'user-fonts'),
    vars: timelineVars,
    totalSec: input.totalSec,
    outputWidth: input.outputWidth,
    outputHeight: input.outputHeight,
    palette: input.palette ?? null,
    fontFacesCss: buildConfigFontFacesCss(input.config, path.join(bundleDir, 'user-fonts')),
    inputHash,
    runtimeBundleVersion: input.config.layoutRuntimeBundleVersion ?? 2,
    geometryManifestHash,
    maxNodes: input.maxNodes,
  };
  try {
    fs.writeFileSync(requestPath, JSON.stringify(request), { encoding: 'utf8', flag: 'wx' });
    return await new Promise<PackagingAutoLayoutResult>((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(makeAbortError());
        return;
      }
      const child = spawnHidden(resolvePackagingNode(), [path.join(bundleDir, 'layout-service.mjs'), requestPath, outputPath], {
        cwd: packagingDir,
        env: { ...process.env, HYPERFRAMES_BROWSER_PATH: chrome, CREATIVE_STUDIO_PACKAGING_DEPENDENCIES_ROOT: packagingLayoutDependenciesRoot(manifest) },
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let stderrTail = '';
      let settled = false;
      let stopError: Error | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (error?: Error, result?: PackagingAutoLayoutResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new PackagingError('layout_resolution_missing', '自动布局未返回有效结果', 409));
      };
      const stop = (error: Error) => {
        if (settled || stopError) return;
        stopError = error;
        clearTimeout(timer);
        killTree(child);
        // close 确认子进程与管道均已退出后再删除请求目录，避免与子进程拷贝竞争。
      };
      const timer = setTimeout(() => stop(new PackagingError('layout_timeout', '自动布局计算超时，请重试', 409)), 120_000);
      const onAbort = () => stop(makeAbortError());
      input.signal?.addEventListener('abort', onAbort, { once: true });
      child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000); });
      child.stdout.resume();
      child.on('error', (error) => {
        stopError ??= new PackagingError('layout_spawn_failed', `自动布局进程启动失败：${error.message}`, 409);
      });
      child.on('close', (code) => {
        if (stopError) { finish(stopError); return; }
        try {
          if (!fs.existsSync(outputPath)) throw new PackagingError('layout_failed', `自动布局失败：${stderrTail || '无错误输出'}`, 409);
          const result = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as PackagingAutoLayoutResult & { inputHash?: string; geometryManifestHash?: string };
          const resultMessage = 'message' in result ? result.message : undefined;
          if (code !== 0 && code !== 3) throw new PackagingError('layout_failed', `自动布局失败：${stderrTail.slice(-800) || resultMessage || '未知错误'}`, 409);
          if (result.status === 'resolved') {
            if (result.inputHash !== inputHash || result.geometryManifestHash !== geometryManifestHash) {
              throw new PackagingError('layout_hash_mismatch', '自动布局结果与当前输入或资源不一致', 409);
            }
            finish(undefined, result);
          } else if (result.status === 'infeasible' || result.status === 'budget_exceeded') finish(undefined, result);
          else throw new PackagingError('layout_failed', `自动布局失败：${resultMessage || '未知错误'}`, 409);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  } finally {
    await fs.promises.rm(requestDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
