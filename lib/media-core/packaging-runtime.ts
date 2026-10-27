import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../data-root.ts';
import { spawnHidden, spawnSyncHidden } from '../spawn-hidden.ts';
import type { PackagingVars, PackagingLayouts } from './packaging-vars.ts';
import type { PackagingStickerDefaults, PackagingStickerInstance } from './packaging-stickers.ts';
import type { PackagingStickerAssetMap } from './packaging-sticker-assets.ts';
import type { PointCue, PointCueDraft } from './packaging-cues.ts';
export class PackagingError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) { super(message); this.code = code; this.status = status; }
}
const PACKAGING_TIMEOUT_MS = 10 * 60_000;

function makeAbortError(): Error {
  const error = new Error('包装任务因服务停机而中止');
  error.name = 'AbortError';
  return error;
}

/** 免安装版优先用内置 node-runtime（与 better-sqlite3 ABI 绑定）；源码开发回退当前进程。 */
export function resolvePackagingNode(): string {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  if (process.env.CREATIVE_STUDIO_PACKAGING_NODE) return process.env.CREATIVE_STUDIO_PACKAGING_NODE;
  const candidates = [
    path.join(dataRoot(), 'node-runtime', exe), // 免安装版：应用根目录
    path.join(process.cwd(), 'node-runtime', exe), // 仓库根（开发）
    path.join(process.cwd(), '..', '..', 'node-runtime', exe), // standalone 进程 cwd（.next/standalone）兜底
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return process.execPath;
}

/**
 * 包装管线目录（含 package-video.mjs / templates / runtime / node_modules）。
 * 免安装版在应用根目录（standalone 进程 cwd 是 .next/standalone，不能直接用 cwd）。
 */
export function resolvePackagingDir(): string {
  if (process.env.CREATIVE_STUDIO_PACKAGING_DIR) return process.env.CREATIVE_STUDIO_PACKAGING_DIR;
  const candidates = [
    path.join(dataRoot(), 'packaging'),
    path.join(process.cwd(), 'packaging'),
    path.join(process.cwd(), '..', '..', 'packaging'),
  ];
  for (const candidate of candidates) if (fs.existsSync(path.join(candidate, 'package-video.mjs'))) return candidate;
  return candidates[0];
}

export function resolvePackagingTemplateDir(packagingDir: string, template?: string): string {
  const name = (template || 'overlay-basic').trim();
  if (!['overlay-basic', 'overlay-poster', 'overlay-journal', 'overlay-minimal', 'overlay-variety'].includes(name)) throw new PackagingError('packaging_template_invalid', '包装模板标识无效');
  const dir = path.join(packagingDir, 'templates', name);
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new PackagingError('packaging_template_missing', `包装模板 ${name} 不存在，请检查 packaging/templates 目录`, 409);
  return dir;
}

export function buildTimelineVars(input: {
  vars: PackagingVars;
  totalSec: number;
  coverSec: number;
  /** Fixed renderer: keep the cover fully visible until the exact frame boundary. */
  staticCover?: boolean;
  /** PointCue（含 id）与提取期草稿（无 id）都接受，写 vars.json 时原样透传。 */
  pointCues: Array<PointCue | PointCueDraft>;
  pointCuesMode: 'timed' | 'even' | 'none';
  /** §7：手动布局透传（模板端读 window.__vars.layouts）。 */
  layouts?: PackagingLayouts;
  stickers?: PackagingStickerInstance[];
  stickerDefaults?: PackagingStickerDefaults;
  stickerAssets?: PackagingStickerAssetMap;
  fonts?: { titleFile?: string; subtitleFile?: string; pointFile?: string };
}): Record<string, unknown> {
  return {
    ...input.vars,
    coverSec: input.staticCover ? input.coverSec : Number(input.coverSec.toFixed(3)),
    ...(input.staticCover ? { staticCover: true } : {}),
    totalSec: Number(Math.max(input.totalSec, input.coverSec + 0.2).toFixed(3)),
    pointCues: input.pointCues,
    pointCuesMode: input.pointCuesMode,
    ...(input.layouts && Object.keys(input.layouts).length > 0 ? { layouts: input.layouts } : {}),
    ...(input.stickers && input.stickers.length > 0 ? { stickers: input.stickers } : {}),
    ...(input.stickerDefaults ? { stickerDefaults: input.stickerDefaults } : {}),
    ...(input.stickers && input.stickers.length > 0 && input.stickerAssets && Object.keys(input.stickerAssets).length > 0 ? { stickerAssets: input.stickerAssets } : {}),
    // 字体文件名为纯文件名（package-video 在 fonts/user/ 下解析并注入 @font-face）
    ...(input.fonts?.titleFile ? { titleFontFile: input.fonts.titleFile } : {}),
    ...(input.fonts?.subtitleFile ? { subtitleFontFile: input.fonts.subtitleFile } : {}),
    ...(input.fonts?.pointFile ? { pointFontFile: input.fonts.pointFile } : {}),
  };
}

function killProcessTree(child: { pid?: number; killed: boolean }): void {
  if (!child.pid || child.killed) return;
  try {
    if (process.platform === 'win32') {
      // 必须同步执行：停机路径上本进程随时会 exit，异步 spawn 的非 detached taskkill
      // 会被 Windows 作业对象随父进程回收，导致杀树失效（2026-09-01 实测复现）。
      // §8 ⑥/§10 ③：windowsHide 防止包装中止时弹出 CMD 窗口（统一入口强制隐藏）。
      spawnSyncHidden('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // 子进程以独立进程组启动（detached），负 pid 杀整组。
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        if (!child.killed) {
          try { process.kill(child.pid, 'SIGKILL'); } catch { /* 进程可能已退出 */ }
        }
      }
    }
  } catch { /* 进程可能已退出 */ }
}

export function runPackagingPipeline(input: {
  nodeExe: string;
  packagingDir: string;
  args: string[];
  signal?: AbortSignal;
  onStage?: (progress: number) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) { reject(makeAbortError()); return; }
    const child = spawnHidden(input.nodeExe, input.args, {
      cwd: input.packagingDir,
      env: { ...process.env, CREATIVE_STUDIO_PACKAGING_WORK_ROOT: path.join(dataRoot(), 'storage', 'packaging', 'renders'), CREATIVE_STUDIO_PACKAGING_USER_FONTS: path.join(dataRoot(), 'storage', 'packaging', 'fonts') },
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stderrTail = '';
    let settled = false;
    const STAGE_PROGRESS: Record<string, number> = { 1: 0.1, 2: 0.2, 3: 0.35, 4: 0.9 };
    child.stdout.on('data', (chunk: Buffer) => {
      const match = /\[(\d)\/4\]/.exec(chunk.toString('utf-8'));
      if (match) input.onStage?.(STAGE_PROGRESS[match[1]] ?? 0.1);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000);
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const killAndReject = (error: Error) => {
      killProcessTree(child);
      finish(error);
    };
    const timer = setTimeout(() => killAndReject(new PackagingError('packaging_timeout', '包装渲染超时（10 分钟），请重试', 409)), PACKAGING_TIMEOUT_MS);
    const onAbort = () => killAndReject(makeAbortError());
    if (input.signal?.aborted) { killAndReject(makeAbortError()); return; }
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish(new PackagingError('packaging_spawn_failed', `包装进程启动失败：${error.message}`, 409)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new PackagingError('packaging_render_failed', `包装管线执行失败（退出码 ${code}）：${stderrTail.slice(-800) || '无错误输出'}`, 409));
    });
  });
}

