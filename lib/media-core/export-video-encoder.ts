import { resolveFfmpegPath, runFfmpeg, type RunFfmpegOptions } from '../ffmpeg.ts';

type ExportEncoder = 'h264_nvenc' | 'libx264';

const GPU_ARGS = ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '20', '-b:v', '0'];
// Preserve the previous libx264 defaults explicitly. CQ and CRF are not equivalent scales.
const CPU_ARGS = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23'];

function assertActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('导出编码已中止');
  error.name = 'AbortError';
  throw error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Shared by both final exporters; previews, proxies and the CPU filter graph stay unchanged. */
export function createExportVideoRunner(deps: {
  run?: typeof runFfmpeg;
  resolvePath?: typeof resolveFfmpegPath;
  now?: () => number;
} = {}) {
  const run = deps.run ?? runFfmpeg;
  const resolvePath = deps.resolvePath ?? resolveFfmpegPath;
  const now = deps.now ?? Date.now;
  let cached: { path: string; supported: boolean; expiresAt: number } | undefined;

  // args must describe ONE temporary output, with its path last and no video encoder options.
  // The caller verifies the finished file and atomically publishes it, as before.
  return async function runExportVideo(args: string[], options: RunFfmpegOptions = {}): Promise<ExportEncoder> {
    assertActive(options.signal);
    const startedAt = now();
    const remainingTimeout = () => {
      if (!options.timeoutMs) return undefined;
      const remaining = options.timeoutMs - (now() - startedAt);
      if (remaining <= 0) throw new Error(`导出编码超时（${options.timeoutMs}ms）`);
      return remaining;
    };
    let encoder: ExportEncoder = 'libx264';
    let binaryPath = '';
    if (process.env.CREATIVE_STUDIO_EXPORT_ENCODER !== 'cpu') {
      binaryPath = resolvePath();
      if (!cached || cached.path !== binaryPath || cached.expiresAt <= now()) {
        let supported = false;
        try {
          // Listing -encoders proves build support only; this also checks the GPU and driver.
          await run([
            '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
            '-i', 'color=black:s=256x256:r=24', '-frames:v', '2', '-an',
            ...GPU_ARGS, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
          ], { signal: options.signal, timeoutMs: Math.min(10_000, remainingTimeout() ?? 10_000) });
          supported = true;
        } catch (error) {
          // Process-level shutdown can raise AbortError without aborting this task's signal.
          if (isAbort(error)) throw error;
          assertActive(options.signal);
          remainingTimeout();
        }
        assertActive(options.signal);
        cached = { path: binaryPath, supported, expiresAt: now() + (supported ? 300_000 : 60_000) };
      }
      if (cached.supported) encoder = 'h264_nvenc';
    }
    const encode = async (selected: ExportEncoder) => {
      assertActive(options.signal);
      const timeoutMs = remainingTimeout();
      console.info(`[export-video] encoder=${selected}`);
      await run([
        ...args.slice(0, -1), ...(selected === 'h264_nvenc' ? GPU_ARGS : CPU_ARGS),
        '-y', args[args.length - 1],
      ], { ...options, timeoutMs });
      assertActive(options.signal);
    };
    try {
      await encode(encoder);
      return encoder;
    } catch (error) {
      if (encoder === 'libx264' || isAbort(error)) throw error;
      assertActive(options.signal);
      remainingTimeout();
      // A driver/session failure after probing must not block export or poison future jobs forever.
      cached = { path: binaryPath, supported: false, expiresAt: now() + 60_000 };
      console.info('[export-video] GPU 编码失败，回退 CPU 重新导出');
      options.onProgressSec?.(0);
      await encode('libx264');
      return 'libx264';
    }
  };
}

export const runExportVideo = createExportVideoRunner();
