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
  width: number;
  height: number;
  fps: number;
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
 * 不转码，供成片模块 4 视频列表/缩略图使用。单个文件探测失败（ffprobe 不可用、
 * 文件损坏、没有视频流、超时）一律 resolve 全零结果，绝不 reject——一条视频探测
 * 失败不应打断整份 context 响应。
 */
export function probeVideoMedia(filePath: string): Promise<VideoMediaProbe> {
  const fallback: VideoMediaProbe = { durationUs: 0, width: 0, height: 0, fps: 0 };
  return new Promise((resolve) => {
    try {
      const child = spawn(
        resolveFfprobePath(),
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', filePath],
        { windowsHide: true }
      );
      let out = '';
      let settled = false;
      const finish = (result: VideoMediaProbe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      // Mirrors runFfmpeg's timeout guard above (kill + settle rather than
      // hang forever), but — per this function's documented "never reject"
      // contract — a timeout resolves the same all-zero fallback as any
      // other probe failure instead of rejecting.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(fallback);
      }, PROBE_VIDEO_MEDIA_TIMEOUT_MS);
      child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
      // Drain stderr so a chatty/stuck ffprobe process can't back up its
      // stderr pipe and hang (same undrained-stderr gap noted elsewhere in
      // this file for supportsFilter; fixed here since this path is now
      // reachable from live HTTP requests).
      child.stderr.on('data', () => {});
      child.on('error', () => finish(fallback));
      child.on('close', (code) => {
        if (code !== 0) { finish(fallback); return; }
        try {
          const parsed = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>; format?: { duration?: string } };
          const stream = parsed.streams?.[0];
          const durationSec = parseFloat(parsed.format?.duration ?? '');
          if (!stream || !Number.isFinite(durationSec)) { finish(fallback); return; }
          finish({
            durationUs: Math.round(durationSec * 1_000_000),
            width: Number(stream.width) || 0,
            height: Number(stream.height) || 0,
            fps: parseFrameRateFraction(stream.r_frame_rate),
          });
        } catch {
          finish(fallback);
        }
      });
    } catch {
      resolve(fallback);
    }
  });
}

function parseFrameRateFraction(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator)) return 0;
  if (!denominator || !Number.isFinite(denominator)) return numerator;
  return numerator / denominator;
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
