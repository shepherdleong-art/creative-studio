import { precheckSeedanceReferenceMedia } from '../../video-providers/reference-media.ts';
import { CanvasAdapterError, type CanvasResolvedInput } from './types.ts';

/** Probe unavailable metadata before delivery; never use unknown duration as zero. */
export async function precheckSeedanceMedia(input: CanvasResolvedInput, model: string): Promise<void> {
  if (input.kind === 'text') return;
  const media = {
    kind: input.kind,
    absolutePath: input.absolutePath,
    mimeType: input.mimeType ?? '',
    byteSize: input.byteSize,
    durationSec: input.durationSec,
  };
  const problems = await precheckSeedanceReferenceMedia(media, model);
  if (input.kind !== 'image') input.durationSec = media.durationSec;
  if (problems.length) throw new CanvasAdapterError('prepare', `素材 @${input.refId}：${problems.join('；')}`, { code: 'media_precheck_failed' });
}
