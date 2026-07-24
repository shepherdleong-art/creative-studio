import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

function canRunBinary(binPath: string): boolean {
  try {
    const r = spawnSync(binPath, ['-version'], { timeout: 5000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function resolveFfmpegPath(): string {
  const env = process.env.CREATIVE_STUDIO_FFMPEG;
  if (env && fs.existsSync(env) && canRunBinary(env)) return env;
  if (typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic) && canRunBinary(ffmpegStatic)) return ffmpegStatic;
  if (canRunBinary('ffmpeg')) return 'ffmpeg';
  // Last resort: return the static path even if it can't run — better to fail
  // with a clear spawn error than "ffmpeg not found".
  if (typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  return 'ffmpeg';
}

export function resolveFfprobePath(): string {
  const env = process.env.CREATIVE_STUDIO_FFPROBE;
  if (env && fs.existsSync(env) && canRunBinary(env)) return env;
  const p = (ffprobeStatic as { path?: string })?.path;
  if (p && fs.existsSync(p) && canRunBinary(p)) return p;
  if (canRunBinary('ffprobe')) return 'ffprobe';
  // Return the static path even if it can't run — probeDurationSec has a
  // ffmpeg-based fallback for this case.
  if (p && fs.existsSync(p)) return p;
  return 'ffprobe';
}

// Metadata probing is used directly by HTTP handlers. Candidate selection on
// that path must not run a synchronous `-version` child process per asset;
// the real async spawn below decides whether the candidate works and falls
// back to ffmpeg when it does not.
function resolveFfprobeCandidatePath(): string {
  const env = process.env.CREATIVE_STUDIO_FFPROBE;
  if (env && fs.existsSync(env)) return env;
  const bundled = (ffprobeStatic as { path?: string })?.path;
  if (bundled && fs.existsSync(bundled)) return bundled;
  return 'ffprobe';
}

function resolveFfmpegCandidatePath(): string {
  const env = process.env.CREATIVE_STUDIO_FFMPEG;
  if (env && fs.existsSync(env)) return env;
  if (typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  return 'ffmpeg';
}

export interface RunFfmpegOptions {
  /** 每次解析到 -progress 输出时回调（已换算为秒） */
  onProgressSec?: (outTimeSec: number) => void;
  timeoutMs?: number;
}

/** 运行 ffmpeg，非零退出码时用 stderr 尾部报错。args 必须含 -y 与输出路径。 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { windowsHide: true });
    let stderrTail = '';
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          done(new Error(`ffmpeg timeout after ${opts.timeoutMs}ms: ${stderrTail.slice(-500)}`));
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (buf: Buffer) => {
      if (!opts.onProgressSec) return;
      let last = -1;
      const re = /out_time_us=(\d+)/g;
      const text = buf.toString();
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) last = Number(m[1]);
      if (last >= 0) opts.onProgressSec(last / 1e6);
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString()).slice(-4000);
    });
    child.on('error', (err) => done(err));
    child.on('close', (code) => {
      if (code === 0) done();
      else done(new Error(`ffmpeg exited with code ${code}: ${stderrTail.slice(-1500)}`));
    });
  });
}

/** ffprobe 取媒体时长（秒）。若 ffprobe 不可用，自动回退用 ffmpeg 解析。 */
export function probeDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobePath = resolveFfprobePath();
    // If ffprobe binary can actually run, use it directly
    if (canRunBinary(ffprobePath)) {
      const child = spawn(
        ffprobePath,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
        { windowsHide: true }
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (b: Buffer) => (out += b.toString()));
      child.stderr.on('data', (b: Buffer) => (err += b.toString()));
      child.on('error', () => {
        // ffprobe spawn itself failed — fall through to ffmpeg
        probeWithFfmpeg(filePath).then(resolve, reject);
      });
      child.on('close', (code) => {
        const dur = parseFloat(out.trim());
        if (code === 0 && Number.isFinite(dur)) {
          resolve(dur);
        } else {
          // ffprobe produced an error — likely a codec issue, fall back to ffmpeg
          probeWithFfmpeg(filePath).then(resolve, reject);
        }
      });
    } else {
      // ffprobe binary can't run at all — use ffmpeg
      probeWithFfmpeg(filePath).then(resolve, reject);
    }
  });
}

/** Use ffmpeg to extract duration by parsing stderr "Duration: HH:MM:SS.ms" line. */
function probeWithFfmpeg(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveFfmpegPath(),
      ['-i', filePath, '-f', 'null', '-'],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (m) {
        const dur = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
        if (Number.isFinite(dur)) {
          resolve(dur);
          return;
        }
      }
      reject(new Error(`ffprobe failed for ${filePath} (ffmpeg fallback also failed): ${stderr.slice(-500)}`));
    });
  });
}

export interface VideoMediaProbe {
  durationUs: number;
  /** 显示宽（已按旋转元数据归一：±90/270° 时与 height 交换） */
  width: number;
  /** 显示高（同上） */
  height: number;
  fps: number;
  format?: string;
  errorMessage?: string;
}

// Metadata-only read, not a transcode — much shorter than runFfmpeg's 30s
// (used elsewhere for actual frame extraction). probeVideoMedia is now
// awaited directly inside live HTTP handlers (final-edit context route +
// module-4 thumbnail route), so a hung ffprobe (e.g. reading a truncated
// file from an interrupted download) must not be able to block a request
// indefinitely.
const PROBE_VIDEO_MEDIA_TIMEOUT_MS = 10_000;

/**
 * ffprobe 一次性取时长 + 视频流宽高/帧率（JSON 输出）。只做元数据读取（毫秒级），
 * 不转码，供成片模块 4 视频列表/缩略图使用。ffprobe 不可用或读取失败时，异步
 * 回退到 ffmpeg 的输入元数据输出（不解码完整视频）；两者都失败才返回全零结果。
 * 失败仍不 reject，避免一条损坏视频打断整份 context 响应；errorMessage 保留 stderr
 * 尾部，供导入接口返回可观察的诊断。
 */
export function probeVideoMedia(filePath: string): Promise<VideoMediaProbe> {
  return new Promise((resolve) => {
    try {
      const child = spawn(
        resolveFfprobeCandidatePath(),
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:stream_tags=rotate:stream_side_data=rotation:format=duration,format_name', '-of', 'json', filePath],
        { windowsHide: true }
      );
      let out = '';
      let stderrTail = '';
      let settled = false;
      let fallbackStarted = false;
      const finish = (result: VideoMediaProbe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const fallbackToFfmpeg = () => {
        if (settled || fallbackStarted) return;
        fallbackStarted = true;
        clearTimeout(timer);
        probeVideoMediaWithFfmpeg(filePath, stderrTail).then(finish);
      };
      // Mirrors runFfmpeg's timeout guard above (kill + settle rather than
      // hang forever), but — per this function's documented "never reject"
      // contract — a timeout resolves the same all-zero fallback as any
      // other probe failure instead of rejecting.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        stderrTail = `${stderrTail}\nffprobe timeout after ${PROBE_VIDEO_MEDIA_TIMEOUT_MS}ms`.slice(-4000);
        fallbackToFfmpeg();
      }, PROBE_VIDEO_MEDIA_TIMEOUT_MS);
      child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { stderrTail = (stderrTail + b.toString()).slice(-4000); });
      child.on('error', (error) => {
        stderrTail = `${stderrTail}\n${error.message}`.slice(-4000);
        fallbackToFfmpeg();
      });
      child.on('close', (code) => {
        if (settled || fallbackStarted) return;
        if (code !== 0) { fallbackToFfmpeg(); return; }
        try {
          const parsed = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number | string }> }>; format?: { duration?: string; format_name?: string } };
          const stream = parsed.streams?.[0];
          const durationSec = parseFloat(parsed.format?.duration ?? '');
          if (!stream || !Number.isFinite(durationSec) || !Number(stream.width) || !Number(stream.height)) { fallbackToFfmpeg(); return; }
          // §7.3 要求读取旋转信息：displaymatrix side data（如 -90）优先，legacy rotate tag 兜底。
          // 下游（分析/预览/缩略图）统一消费显示尺寸，±90/270° 时交换宽高。
          const rotation = normalizeRotationDegrees(stream.side_data_list?.find((item) => Number.isFinite(Number(item?.rotation)))?.rotation ?? stream.tags?.rotate);
          const swap = rotation % 180 === 90;
          finish({
            durationUs: Math.round(durationSec * 1_000_000),
            width: Number(swap ? stream.height : stream.width) || 0,
            height: Number(swap ? stream.width : stream.height) || 0,
            fps: parseFrameRateFraction(stream.r_frame_rate),
            format: parsed.format?.format_name || '',
          });
        } catch {
          fallbackToFfmpeg();
        }
      });
    } catch (error) {
      probeVideoMediaWithFfmpeg(filePath, error instanceof Error ? error.message : String(error)).then(resolve);
    }
  });
}

function probeVideoMediaWithFfmpeg(filePath: string, ffprobeError: string): Promise<VideoMediaProbe> {
  return new Promise((resolve) => {
    let stderrTail = '';
    let settled = false;
    const child = spawn(resolveFfmpegCandidatePath(), ['-hide_banner', '-i', filePath], { windowsHide: true });
    const finish = (result: VideoMediaProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = (message?: string) => finish({
      durationUs: 0,
      width: 0,
      height: 0,
      fps: 0,
      errorMessage: [ffprobeError, stderrTail, message].filter(Boolean).join('\n').slice(-1500),
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      failed(`ffmpeg metadata probe timeout after ${PROBE_VIDEO_MEDIA_TIMEOUT_MS}ms`);
    }, PROBE_VIDEO_MEDIA_TIMEOUT_MS);
    child.stdout.on('data', () => {});
    child.stderr.on('data', (buffer: Buffer) => { stderrTail = (stderrTail + buffer.toString()).slice(-8000); });
    child.on('error', (error) => failed(error.message));
    child.on('close', () => {
      if (settled) return;
      const durationMatch = stderrTail.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      const formatMatch = stderrTail.match(/Input #0,\s*(.+?),\s+from /);
      const videoLine = stderrTail.split(/\r?\n/).find((line) => /Stream .*Video:/.test(line)) || '';
      const dimensionsMatch = videoLine.match(/Video:[^\n]*?(?:,|\s)(\d{2,6})x(\d{2,6})(?=[,\s\[]|$)/);
      if (!durationMatch || !dimensionsMatch) { failed('ffmpeg metadata output did not contain a readable video stream'); return; }
      const durationSec = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
      const fpsMatch = videoLine.match(/(?:,|\s)(\d+(?:\.\d+)?)\s*fps(?:,|\s)/);
      if (!Number.isFinite(durationSec) || durationSec <= 0) { failed('ffmpeg returned an invalid video duration'); return; }
      // ffmpeg -i 的旋转线索：`rotate : 90`（流元数据）或 `displaymatrix: rotation of -90.00 degrees`。
      const rotateTag = stderrTail.match(/rotate\s*:\s*(-?\d+)/) || stderrTail.match(/rotation of\s+(-?[\d.]+)\s+degrees/);
      const swap = normalizeRotationDegrees(rotateTag?.[1]) % 180 === 90;
      finish({
        durationUs: Math.round(durationSec * 1_000_000),
        width: Number(dimensionsMatch[swap ? 2 : 1]) || 0,
        height: Number(dimensionsMatch[swap ? 1 : 2]) || 0,
        fps: fpsMatch ? Number(fpsMatch[1]) || 0 : 0,
        format: formatMatch?.[1]?.trim() || '',
      });
    });
  });
}

function parseFrameRateFraction(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator)) return 0;
  if (!denominator || !Number.isFinite(denominator)) return numerator;
  return numerator / denominator;
}

/** 把 ffprobe/ffmpeg 各种来源的旋转角归一到 [0,360)；非法输入按 0 处理 */
function normalizeRotationDegrees(value: unknown): number {
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) return 0;
  return ((Math.round(degrees) % 360) + 360) % 360;
}

const filterCache = new Map<string, boolean>();

/** 探测滤镜可用性（sidechaincompress / tpad 等），结果缓存 */
export function supportsFilter(name: string): Promise<boolean> {
  const cached = filterCache.get(name);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const child = spawn(resolveFfmpegPath(), ['-hide_banner', '-filters'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.on('error', () => resolve(false));
    child.on('close', () => {
      const ok = new RegExp(`\\s${name}\\s`).test(out);
      filterCache.set(name, ok);
      resolve(ok);
    });
  });
}
