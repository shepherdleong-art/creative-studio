import type { CanvasModelCapability } from '../capabilities.ts';
import type { CanvasGenerationMode } from '../types.ts';
import { SEEDANCE_20, SEEDANCE_25, SEEDANCE_FAST, seedanceContract } from '../../video-providers/seedance-contract.ts';

/** Direct Ark only. Company capability publication requires gateway evidence. */
export function directSeedanceCapability(model: typeof SEEDANCE_20 | typeof SEEDANCE_25 | typeof SEEDANCE_FAST): CanvasModelCapability {
  const v25 = model === SEEDANCE_25;
  const contract = seedanceContract(model)!;
  const imageMimeTypes = v25 ? ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff', 'image/gif', 'image/heic', 'image/heif'] : ['image/jpeg', 'image/png', 'image/webp'];
  const referenceModes: CanvasGenerationMode[] = ['reference-to-video', 'video-to-video', 'video-edit', 'video-extend'];
  const freeModes: CanvasGenerationMode[] = v25
    ? ['text-to-video', 'reference-to-video', 'frames-to-video', 'video-to-video']
    : ['text-to-video', ...referenceModes, 'frames-to-video'];
  return {
    key: v25 ? 'external-jimeng-seedance-2-5' : 'external-jimeng-seedance-2-0',
    displayName: `即梦 Seedance ${v25 ? '2.5' : '2.0'}（直连方舟）`,
    providerKind: 'external', providerIdentity: 'jimeng-2-0', modelAlias: model, mediaKind: 'video',
    modes: ['text-to-video', 'reference-to-video', 'image-to-video', 'frames-to-video', 'video-edit', 'video-extend', 'video-to-video'],
    legacyModes: ['video-to-video'],
    inputs: [
      { kind: 'image', mimeTypes: imageMimeTypes, roles: ['first-frame', 'last-frame', 'subject', 'reference'], min: 1, max: 2, modes: ['image-to-video'] },
      { kind: 'image', mimeTypes: imageMimeTypes, roles: ['reference', 'subject', 'product', 'style', 'scene'], min: 0, max: contract.imageCount, modes: referenceModes },
      { kind: 'image', mimeTypes: imageMimeTypes, roles: ['reference', 'subject', 'product', 'style', 'scene'], min: 2, max: contract.imageCount, modes: ['frames-to-video'] },
      { kind: 'video', roles: ['reference', 'camera'], min: 0, max: contract.mediaCount, modes: ['reference-to-video'], maxDurationSec: contract.maxDuration },
      { kind: 'video', roles: ['reference', 'camera'], min: 1, max: contract.mediaCount, modes: ['video-to-video', 'video-edit', 'video-extend'], maxDurationSec: contract.maxDuration },
      { kind: 'audio', roles: ['audio'], min: 0, max: contract.mediaCount, modes: referenceModes,
        mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/x-wav'], maxDurationSec: contract.maxDuration, maxBytes: 15 * 1024 * 1024 },
      { kind: 'text', roles: ['reference'], min: 0, max: 1 },
    ],
    mediaInputMinimums: [{ modes: ['reference-to-video'], min: 1, ...(v25 ? {} : { kinds: ['image', 'video'] as const }) }],
    parameters: [
      ...(v25 ? [
        { key: 'generationStage', label: '生成阶段', type: 'enum' as const, options: ['direct', 'draft', 'final-from-draft'], default: 'direct' },
        { key: 'draftAssetId', label: '固定样片', type: 'string' as const },
        { key: 'directResolution', label: '直接生成分辨率偏好', type: 'enum' as const, options: contract.resolutions },
      ] : []),
      { key: 'resolution', label: '分辨率', type: 'enum', options: contract.resolutions, default: model === SEEDANCE_FAST ? '720p' : '1080p' },
      { key: 'durationSec', label: '时长（秒）', type: 'integer', min: 4, max: contract.maxDuration, specialValues: [-1], default: 5,
        ...(v25 ? { modes: ['text-to-video', 'image-to-video', 'reference-to-video', 'frames-to-video', 'video-extend', 'video-to-video'] as CanvasGenerationMode[] } : {}) },
      { key: 'aspectRatio', label: '比例', type: 'enum', options: ['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'], default: '16:9', modes: freeModes },
      { key: 'withAudio', label: '生成声音', type: 'boolean', default: true },
      ...(v25 ? [{ key: 'outputFormat', label: '输出格式', type: 'enum' as const, options: ['mp4','mov'], default: 'mp4' }] : []),
      { key: 'watermark', label: '水印', type: 'boolean', default: false },
      { key: 'returnLastFrame', label: '返回尾帧', type: 'boolean', default: false },
    ],
    modeLabels: { 'reference-to-video': '全能参考', 'image-to-video': '首尾帧', 'video-extend': '视频延长', 'video-to-video': '视频生视频（旧模式）' },
    modeHints: {
      'reference-to-video': v25 ? '至少一份图、视频或音频；支持纯音频参考。' : '至少一份图或视频；音频需要搭配视觉素材。',
      'frames-to-video': '按图片顺序参考，可用分段提示词描述时间；不保证精确命中时间点。',
      'video-edit': v25 ? '至少一段 4–30 秒视频；比例和时长跟随源视频。' : '至少一段参考视频；通过提示词描述编辑内容。',
      'video-extend': `单次最多 ${contract.maxDuration} 秒；结果可继续延长，本期不自动拼接原视频。`,
    },
    cancellation: false, evidence: 'mapped',
    evidenceNote: '按用户提供的 Seedance 2.0/2.5 官方教程对齐；新增模式、分辨率和边界仍待真实样本，历史样例不覆盖所有组合。',
  };
}
