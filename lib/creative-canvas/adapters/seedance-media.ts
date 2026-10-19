import sharp from 'sharp';
import { probeDurationSec, probeVideoMedia } from '../../ffmpeg.ts';
import { SEEDANCE_25 } from '../../video-providers/seedance-contract.ts';
import { CanvasAdapterError, type CanvasResolvedInput } from './types.ts';

/** Probe unavailable metadata before delivery; never use unknown duration as zero. */
export async function precheckSeedanceMedia(input: CanvasResolvedInput, model: string): Promise<void> {
  if (!input.absolutePath || input.kind === 'text') return;
  const problems: string[] = [];
  const dimensions = (width: number, height: number) => {
    if (!width || !height || width < 300 || height < 300 || width > 6000 || height > 6000 || width / height < 0.4 || width / height > 2.5) {
      problems.push('宽高须为 300–6000 像素，宽高比须在 0.4–2.5 之间');
    }
  };
  if (input.kind !== 'image' && (input.durationSec === null || !Number.isFinite(input.durationSec))) {
    const duration = await probeDurationSec(input.absolutePath);
    if (!Number.isFinite(duration) || duration <= 0) problems.push('无法探测素材时长');
    else input.durationSec = duration;
  }
  if (model === SEEDANCE_25) {
    if (input.kind === 'image') {
      const metadata = await sharp(input.absolutePath).metadata().catch(() => probeVideoMedia(input.absolutePath!));
      dimensions(metadata.width ?? 0, metadata.height ?? 0);
      if ((input.byteSize ?? Infinity) >= 30 * 1024 * 1024) problems.push('图片须小于 30 MB');
    } else if (input.kind === 'video') {
      const probe = await probeVideoMedia(input.absolutePath);
      dimensions(probe.width, probe.height);
      const pixels = probe.width * probe.height;
      if (pixels < 407696 || pixels > 8295044) problems.push('视频总像素超出允许范围');
      if (probe.fps < 24 || probe.fps > 60) problems.push('视频帧率须在 24–60 FPS 之间');
      if (!['h264', 'hevc'].includes(probe.videoCodec ?? '')) problems.push('视频须采用 H.264 或 H.265 编码');
      if (probe.hasAudio && !['aac', 'mp3'].includes(probe.audioCodec ?? '')
        && !(input.mimeType === 'video/quicktime' && probe.audioCodec?.startsWith('pcm_'))) problems.push('视频音轨编码不支持');
    }
  }
  if (problems.length) throw new CanvasAdapterError('prepare', `素材 @${input.refId}：${problems.join('；')}`, { code: 'media_precheck_failed' });
}
