// lib/final-video/ffmpeg-graph.ts
/**
 * 单趟 FFmpeg 渲染参数构建：
 *   视频：各片段 scale-cover-crop → (按需 tpad 定格) → concat → (可选 subtitles)
 *   音频：口播/BGM 组合，BGM 可 sidechaincompress ducking（探测失败退化 amix）
 * 参考：混剪计划 §Task 3.2 音频图的 TS 移植；输出时长用显式 -t 保证确定性。
 */
import type { LegacyTimelineSegment, TimelineSegment } from './types.ts';

/** subtitles/fontsdir 的 filter 内路径转义（Windows 盘符冒号 + 反斜杠 + 单引号） */
export function escapeSubtitlePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** drawtext 文本转义 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

export interface RenderGraphInput {
  segments: LegacyTimelineSegment[];
  width: number;
  height: number;
  fps: number;
  totalDurationSec: number;
  introDurationSec: number;
  coverJpgPath: string | null;
  /** 已含片头静音偏移的完整口播音轨（Task 14 产出），无口播传 null */
  narrationTrackPath: string | null;
  bgm: { path: string; volume: number; ducking: boolean } | null;
  duckingSupported: boolean;
  assPath: string | null;
  fontsDir: string;
  outputPath: string;
}

export function buildRenderArgs(g: RenderGraphInput): string[] {
  return buildArgs(g, (s, scaleChain) => {
    const pad = s.segmentDurationSec - s.clipDurationSec;
    const padPart = pad > 0.01 ? `,tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}` : '';
    return `setpts=PTS-STARTPTS,${scaleChain}${padPart}`;
  });
}

export interface SolvedRenderGraphInput extends Omit<RenderGraphInput, 'segments'> {
  segments: TimelineSegment[];
}

const SOLVED_EPSILON = 1e-9;
const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;
const duration = (value: number) => (Math.abs(value) < 0.0005 ? 0 : value).toFixed(3);

function validateSolvedGraph(g: SolvedRenderGraphInput): void {
  if (g.segments.length === 0) throw new Error('Solved render graph requires at least one segment');
  if (!finitePositive(g.width) || !finitePositive(g.height) || !finitePositive(g.fps) || !finitePositive(g.totalDurationSec)) {
    throw new Error('Solved render graph dimensions, fps, and total duration must be finite positive values');
  }
  if (!finiteNonNegative(g.introDurationSec)) throw new Error('Solved render graph intro duration must be finite and non-negative');
  for (const [index, s] of g.segments.entries()) {
    if (!s.clipPath.trim() || !finitePositive(s.clipDurationSec) || !finitePositive(s.segmentDurationSec)
      || !finiteNonNegative(s.mediaDurationSec) || !finiteNonNegative(s.padStopSec) || !finiteNonNegative(s.startSec)) {
      throw new Error(`Invalid solved render segment at index ${index}`);
    }
    if (Math.abs(s.segmentDurationSec - (s.mediaDurationSec + s.padStopSec)) > SOLVED_EPSILON) {
      throw new Error(`Solved render segment duration mismatch at index ${index}`);
    }
    if (s.trimEndToSec !== null) {
      if (!finitePositive(s.trimEndToSec) || Math.abs(s.trimEndToSec - s.mediaDurationSec) > SOLVED_EPSILON
        || s.trimEndToSec - s.clipDurationSec > SOLVED_EPSILON) {
        throw new Error(`Invalid solved render trim at index ${index}`);
      }
    } else if (s.mediaDurationSec - s.clipDurationSec > SOLVED_EPSILON) {
      throw new Error(`Solved render media exceeds clip at index ${index}`);
    }
  }
  const segmentTotal = g.segments.reduce((sum, s) => sum + s.segmentDurationSec, 0);
  const tolerance = Math.max(1e-6, 1 / g.fps);
  if (Math.abs(g.introDurationSec + segmentTotal - g.totalDurationSec) > tolerance) {
    throw new Error('Solved render graph total duration mismatch');
  }
}

export function buildSolvedRenderArgs(g: SolvedRenderGraphInput): string[] {
  validateSolvedGraph(g);
  return buildArgs(g, (s, scaleChain) => {
    const trimPart = s.trimEndToSec === null ? '' : `trim=duration=${duration(s.trimEndToSec)},`;
    const padPart = s.padStopSec > SOLVED_EPSILON
      ? `,tpad=stop_mode=clone:stop_duration=${duration(s.padStopSec)}`
      : '';
    return `${trimPart}setpts=PTS-STARTPTS${padPart},${scaleChain}`;
  });
}

function buildArgs<S extends { clipPath: string }>(
  g: Omit<RenderGraphInput, 'segments'> & { segments: S[] },
  videoChain: (segment: S, scaleChain: string) => string,
): string[] {
  const { width: w, height: h, fps } = g;
  const args: string[] = ['-hide_banner', '-nostats'];
  const hasIntro = g.introDurationSec > 0 && !!g.coverJpgPath;

  // ── 输入 ──
  if (hasIntro) args.push('-loop', '1', '-t', String(g.introDurationSec), '-i', g.coverJpgPath!);
  for (const s of g.segments) args.push('-i', s.clipPath);
  let narrIdx = -1;
  let bgmIdx = -1;
  let next = (hasIntro ? 1 : 0) + g.segments.length;
  if (g.narrationTrackPath) {
    narrIdx = next++;
    args.push('-i', g.narrationTrackPath);
  }
  if (g.bgm) {
    bgmIdx = next++;
    args.push('-stream_loop', '-1', '-i', g.bgm.path);
  }

  // ── 视频图 ──
  const scaleChain = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;
  const parts: string[] = [];
  const vLabels: string[] = [];
  const base = hasIntro ? 1 : 0;
  if (hasIntro) {
    parts.push(`[0:v]${scaleChain}[vintro]`);
    vLabels.push('[vintro]');
  }
  g.segments.forEach((s, i) => {
    parts.push(`[${base + i}:v]${videoChain(s, scaleChain)}[v${i}]`);
    vLabels.push(`[v${i}]`);
  });
  parts.push(`${vLabels.join('')}concat=n=${vLabels.length}:v=1:a=0[vcat]`);
  let vOut = '[vcat]';
  if (g.assPath) {
    const fontsdir = g.fontsDir ? `:fontsdir='${escapeSubtitlePath(g.fontsDir)}'` : '';
    parts.push(`[vcat]subtitles=filename='${escapeSubtitlePath(g.assPath)}'${fontsdir}[vsub]`);
    vOut = '[vsub]';
  }

  // ── 音频图 ──
  let aOut = '';
  if (narrIdx >= 0 && bgmIdx >= 0) {
    if (g.bgm!.ducking && g.duckingSupported) {
      parts.push(
        `[${bgmIdx}:a]volume=${g.bgm!.volume}[bgmv]`,
        `[${narrIdx}:a]asplit=2[narrA][narrB]`,
        `[bgmv][narrA]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`,
        `[duck][narrB]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`
      );
    } else {
      parts.push(
        `[${bgmIdx}:a]volume=${g.bgm!.volume}[bgmv]`,
        `[bgmv][${narrIdx}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`
      );
    }
    aOut = '[aout]';
  } else if (narrIdx >= 0) {
    parts.push(`[${narrIdx}:a]anull[aout]`);
    aOut = '[aout]';
  } else if (bgmIdx >= 0) {
    const fadeStart = Math.max(0, g.totalDurationSec - 1.5);
    parts.push(`[${bgmIdx}:a]volume=${g.bgm!.volume},afade=t=out:st=${fadeStart.toFixed(2)}:d=1.5[aout]`);
    aOut = '[aout]';
  }

  args.push('-filter_complex', parts.join(';'));
  args.push('-map', vOut);
  if (aOut) args.push('-map', aOut, '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-t', g.totalDurationSec.toFixed(3),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-y', g.outputPath
  );
  return args;
}
