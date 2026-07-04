// lib/final-video/ffmpeg-graph.ts
/**
 * 单趟 FFmpeg 渲染参数构建：
 *   视频：各片段 scale-cover-crop → (按需 tpad 定格) → concat → (可选 subtitles)
 *   音频：口播/BGM 组合，BGM 可 sidechaincompress ducking（探测失败退化 amix）
 * 参考：混剪计划 §Task 3.2 音频图的 TS 移植；输出时长用显式 -t 保证确定性。
 */
import type { TimelineSegment } from './types.ts';

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
  segments: TimelineSegment[];
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
    const pad = s.segmentDurationSec - s.clipDurationSec;
    const padPart = pad > 0.01 ? `,tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}` : '';
    parts.push(`[${base + i}:v]setpts=PTS-STARTPTS,${scaleChain}${padPart}[v${i}]`);
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
