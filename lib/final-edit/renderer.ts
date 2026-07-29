import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { runFfmpeg, probeDurationSec } from '../ffmpeg.ts';
import { FINAL_EDIT_INTRO_DURATION_US, OUTPUT_PRESETS, type FinalEditVariantView, type OutputPresetId, type SubtitleCue, type TextStyle } from './types.ts';
import { resolveStoragePath } from './storage-path.ts';
import { resolveImportedExternalAssetVideoPath } from './material-import.ts';
import { coverFramingGeometry } from './cover-framing.ts';
import type { ReservedProjectExportTarget } from './export-naming.ts';
import type { ExportIdentity } from './types.ts';

export interface FinalEditRenderSnapshot {
  groupRevision: number;
  variantRevision: number;
  group: { narrationDurationUs: number; narrationPlaybackRate?: number; subtitleCues: SubtitleCue[] };
  variant: FinalEditVariantView;
  sources: Array<{ videoJobId: string; relativePath: string; fingerprint: string; externalScope?: { projectId: string; shotSetId: string } }>;
  coverRelativePath: string;
  narrationRelativePath: string;
  bgm: { id: string; relativePath: string; fileFingerprint: string; gainDb: number; loop: boolean; fadeInSec: number; fadeOutSec: number } | null;
  overlayBundle: { id: string; relativeDir: string; manifest: unknown };
  /** Added in Mixcut Phase 6; optional only while recovering older queued snapshots. */
  exportIdentity?: ExportIdentity;
  /** Added in Mixcut Phase 6; worker fills it once for older queued snapshots. */
  exportTarget?: ReservedProjectExportTarget;
  /** §10.5 字体审计：记录渲染所用文字样式（含 fontFamily）；旧快照恢复时可能缺失。 */
  textStyles?: { coverPrimary: TextStyle; coverSecondary: TextStyle; subtitle: TextStyle };
}

async function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function clipFilter(index: number, preset: OutputPresetId, framing: FinalEditVariantView['timeline']['clips'][number]['framing']): string {
  const { width, height } = OUTPUT_PRESETS[preset];
  const scale = Math.max(1, Math.min(3, framing.scale));
  const offsetX = Math.max(-1, Math.min(1, framing.offsetX));
  const offsetY = Math.max(-1, Math.min(1, framing.offsetY));
  if (preset === '16x9') {
    return `[${index}:v]fps=24,setsar=1,split=2[bg${index}][fg${index}];` +
      `[bg${index}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2[blur${index}];` +
      `[fg${index}]scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=iw*${scale.toFixed(4)}:ih*${scale.toFixed(4)}[front${index}];` +
      `[blur${index}][front${index}]overlay='(W-w)/2+${offsetX.toFixed(4)}*abs(W-w)/2':'(H-h)/2+${offsetY.toFixed(4)}*abs(H-h)/2',setsar=1,format=yuv420p[v${index}]`;
  }
  return `[${index}:v]fps=24,scale=${width}:${height}:force_original_aspect_ratio=increase,scale=iw*${scale.toFixed(4)}:ih*${scale.toFixed(4)},crop=${width}:${height}:'(iw-${width})/2+${offsetX.toFixed(4)}*(iw-${width})/2':'(ih-${height})/2+${offsetY.toFixed(4)}*(ih-${height})/2',setsar=1,format=yuv420p[v${index}]`;
}

export function subtitleOverlayEnableExpression(startSec: number, endSec: number): string {
  return 'gte(t,' + startSec.toFixed(6) + ')*lt(t,' + endSec.toFixed(6) + ')';
}

export async function renderFinalEditSnapshot(input: {
  jobId: string;
  storageRoot: string;
  snapshot: FinalEditRenderSnapshot;
  onProgress?: (progress: number) => void;
}) {
  const { snapshot, storageRoot } = input;
  const narrationPlaybackRate = Number.isFinite(snapshot.group.narrationPlaybackRate)
    ? Math.max(0.5, Math.min(2, Number(snapshot.group.narrationPlaybackRate)))
    : 1;
  const sourceNarrationSec = snapshot.group.narrationDurationUs / 1_000_000;
  const bodySec = sourceNarrationSec / narrationPlaybackRate;
  const totalSec = FINAL_EDIT_INTRO_DURATION_US / 1_000_000 + bodySec;
  const preset = snapshot.variant.outputPreset;
  const output = OUTPUT_PRESETS[preset];
  const jobRelativeDir = path.join('final-edits', 'jobs', input.jobId);
  const jobDir = resolveStoragePath(storageRoot, jobRelativeDir);
  fs.mkdirSync(path.join(jobDir, 'tmp'), { recursive: true });
  const sourceById = new Map(snapshot.sources.map((source) => [source.videoJobId, source]));
  const resolveSource = (source: FinalEditRenderSnapshot['sources'][number]) => source.externalScope
    ? resolveImportedExternalAssetVideoPath(storageRoot, source.externalScope, source.relativePath)
    : resolveStoragePath(storageRoot, source.relativePath);
  for (const source of snapshot.sources) {
    const absolute = resolveSource(source);
    if (!fs.existsSync(absolute) || await fileSha256(absolute) !== source.fingerprint) throw new Error(`视频素材已变化：${source.videoJobId}`);
  }
  const coverSource = resolveStoragePath(storageRoot, snapshot.coverRelativePath);
  const narration = resolveStoragePath(storageRoot, snapshot.narrationRelativePath);
  const bgmPath = snapshot.bgm ? resolveStoragePath(storageRoot, snapshot.bgm.relativePath) : null;
  const overlayDir = resolveStoragePath(storageRoot, snapshot.overlayBundle.relativeDir);
  if (![coverSource, narration, path.join(overlayDir, 'title.png')].every(fs.existsSync)) throw new Error('封面、口播或文字图层文件缺失');
  if (snapshot.bgm && (!bgmPath || !fs.existsSync(bgmPath) || await fileSha256(bgmPath) !== snapshot.bgm.fileFingerprint)) throw new Error('BGM 文件缺失或内容已变化');

  const coverPng = path.join(jobDir, 'cover.png');
  const coverJpg = path.join(jobDir, 'cover.jpg');
  const coverFraming = snapshot.variant.cover.framing || { scale: 1, offsetX: 0, offsetY: 0 };
  const source = sharp(coverSource).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('封面底图尺寸无效');
  const { resizedWidth, resizedHeight, left, top } = coverFramingGeometry({ sourceWidth: metadata.width, sourceHeight: metadata.height, outputWidth: output.width, outputHeight: output.height, framing: coverFraming });
  await source
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .extract({ left, top, width: output.width, height: output.height })
    .composite([{ input: path.join(overlayDir, 'title.png') }])
    .png()
    .toFile(coverPng);
  await sharp(coverPng).jpeg({ quality: 92 }).toFile(coverJpg);

  const clips = [...snapshot.variant.timeline.clips].sort((a, b) => a.timelineInFrame - b.timelineInFrame);
  if (clips.length === 0) throw new Error('时间轴没有视频片段');
  const args: string[] = ['-loop', '1', '-framerate', '24', '-i', coverPng];
  for (const clip of clips) {
    const source = sourceById.get(clip.videoJobId);
    if (!source) throw new Error(`快照缺少视频素材：${clip.videoJobId}`);
    args.push('-ss', (clip.sourceInFrame / 24).toFixed(6), '-t', ((clip.sourceOutFrame - clip.sourceInFrame) / 24).toFixed(6), '-i', resolveSource(source));
  }
  const narrationInput = clips.length + 1;
  args.push('-i', narration);
  const bgmInput = snapshot.bgm ? narrationInput + 1 : null;
  if (bgmPath) args.push('-stream_loop', '-1', '-i', bgmPath);
  const subtitleStartInput = narrationInput + 1 + (bgmInput == null ? 0 : 1);
  for (const cue of snapshot.group.subtitleCues) {
    const subtitlePath = path.join(overlayDir, `subtitle-${cue.id}.png`);
    if (!fs.existsSync(subtitlePath)) throw new Error(`字幕图层缺失：${cue.id}`);
    args.push('-loop', '1', '-framerate', '24', '-i', subtitlePath);
  }

  const filters: string[] = [];
  filters.push(`[0:v]trim=duration=${(FINAL_EDIT_INTRO_DURATION_US / 1_000_000).toFixed(6)},setpts=PTS-STARTPTS,scale=${output.width}:${output.height},fps=24,format=yuv420p[intro]`);
  clips.forEach((clip, index) => filters.push(clipFilter(index + 1, preset, clip.framing)));
  filters.push(`${clips.map((_, index) => `[v${index + 1}]`).join('')}concat=n=${clips.length}:v=1:a=0[body]`);
  filters.push(`[intro][body]concat=n=2:v=1:a=0[basepre]`);
  // 当前口播音轨放慢后，视频轨用最后一帧补足到新的有效时长；加速时最终 -t 直接裁短。
  // stop_duration 取完整 body 时长，可同时覆盖 matcher 的小缺口和最大 0.5x 的延长量。
  filters.push(`[basepre]tpad=stop_mode=clone:stop_duration=${Math.max(0.5, bodySec).toFixed(6)}[base]`);
  let currentVideo = 'base';
  snapshot.group.subtitleCues.forEach((cue, index) => {
    const next = `subtitle${index}`;
    const start = (FINAL_EDIT_INTRO_DURATION_US + cue.startUs / narrationPlaybackRate) / 1_000_000;
    const end = (FINAL_EDIT_INTRO_DURATION_US + cue.endUs / narrationPlaybackRate) / 1_000_000;
    filters.push(`[${currentVideo}][${subtitleStartInput + index}:v]overlay=0:0:enable='${subtitleOverlayEnableExpression(start, end)}'[${next}]`);
    currentVideo = next;
  });
  const narrationTempo = Math.abs(narrationPlaybackRate - 1) < 1e-8 ? '' : `atempo=${narrationPlaybackRate.toFixed(4)},`;
  filters.push(`[${narrationInput}:a]${narrationTempo}aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,atrim=duration=${bodySec.toFixed(6)},asetpts=PTS-STARTPTS[narration]`);
  if (snapshot.bgm && bgmInput != null) {
    const fadeInDuration = Math.min(Math.max(0, snapshot.bgm.fadeInSec), bodySec);
    const fadeOutDuration = Math.min(Math.max(0, snapshot.bgm.fadeOutSec), bodySec);
    const fadeStart = Math.max(0, bodySec - fadeOutDuration);
    const fades = [
      fadeInDuration > 0 ? `afade=t=in:st=0:d=${fadeInDuration.toFixed(6)}` : '',
      fadeOutDuration > 0 ? `afade=t=out:st=${fadeStart.toFixed(6)}:d=${fadeOutDuration.toFixed(6)}` : '',
    ].filter(Boolean).join(',');
    filters.push(`[${bgmInput}:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,volume=${snapshot.bgm.gainDb}dB,atrim=duration=${bodySec.toFixed(6)},${fades ? `${fades},` : ''}asetpts=PTS-STARTPTS[music]`);
    filters.push(`[narration][music]amix=inputs=2:duration=longest:dropout_transition=0[bodyaudio]`);
  } else {
    filters.push('[narration]anull[bodyaudio]');
  }
  filters.push(`[bodyaudio]adelay=833.333|833.333,apad,atrim=duration=${totalSec.toFixed(6)},alimiter=limit=0.84[audio]`);
  const filterFile = path.join(jobDir, 'filter-complex.txt');
  fs.writeFileSync(filterFile, filters.join(';\n'));
  const tempVideo = path.join(jobDir, 'final.mp4.tmp');
  const finalVideo = path.join(jobDir, 'final.mp4');
  await runFfmpeg([...args, '-filter_complex_script', filterFile, '-map', `[${currentVideo}]`, '-map', '[audio]', '-t', totalSec.toFixed(6), '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-y', tempVideo], {
    timeoutMs: 30 * 60_000,
    onProgressSec: (outTimeSec) => input.onProgress?.(Math.max(0, Math.min(1, outTimeSec / totalSec))),
  });
  const actualDuration = await probeDurationSec(tempVideo);
  if (Math.abs(actualDuration - totalSec) > 1 / 24 + 0.01) throw new Error(`产物时长校验失败：${actualDuration.toFixed(3)}s，预期 ${totalSec.toFixed(3)}s`);
  fs.renameSync(tempVideo, finalVideo);
  return { videoRelativePath: path.join(jobRelativeDir, 'final.mp4'), coverRelativePath: path.join(jobRelativeDir, 'cover.jpg'), durationSec: actualDuration, width: output.width, height: output.height, fps: 24 };
}
