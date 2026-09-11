/**
 * fixture 能力注册：只在 `CREATIVE_STUDIO_CANVAS_EXECUTOR=fixture` 且数据根被显式标记时调用。
 *
 * 这些能力不是公司能力，evidence 固定为 candidate，界面上只用于隔离测试；
 * 真实模型的能力注册在 P4（公司适配器）完成，两者不互相提升证据层级。
 */

import { registerCanvasCapability } from '../capabilities.ts';

export const FIXTURE_IMAGE_CAPABILITY_KEY = 'fixture-image-edit';
export const FIXTURE_VIDEO_CAPABILITY_KEY = 'fixture-video';

export function registerFixtureCanvasCapabilities(): void {
  registerCanvasCapability({
    key: FIXTURE_IMAGE_CAPABILITY_KEY,
    displayName: '测试图片模型（fixture）',
    providerKind: 'external',
    providerIdentity: 'creative-canvas-fixture',
    modelAlias: 'fixture/image-edit',
    mediaKind: 'image',
    modes: ['image-to-image', 'text-to-image'],
    inputs: [
      { kind: 'image', roles: ['subject', 'reference', 'style', 'scene'], min: 0, max: 4 },
      { kind: 'text', roles: ['reference'], min: 0, max: 1 },
    ],
    parameters: [
      { key: 'ratio', label: '比例', type: 'enum', options: ['1:1', '3:4', '4:3'], default: '1:1' },
    ],
    cancellation: false,
    evidence: 'candidate',
    evidenceNote: '本地 fixture 能力，仅用于隔离测试；不代表任何真实模型。',
  });

  registerCanvasCapability({
    key: FIXTURE_VIDEO_CAPABILITY_KEY,
    displayName: '测试视频模型（fixture）',
    providerKind: 'external',
    providerIdentity: 'creative-canvas-fixture',
    modelAlias: 'fixture/video',
    mediaKind: 'video',
    modes: ['image-to-video', 'text-to-video'],
    inputs: [
      { kind: 'image', roles: ['first-frame', 'last-frame', 'reference', 'subject'], min: 0, max: 2 },
      { kind: 'text', roles: ['reference'], min: 0, max: 1 },
    ],
    parameters: [
      { key: 'durationSec', label: '时长（秒）', type: 'integer', min: 3, max: 15, default: 5 },
      { key: 'withAudio', label: '生成声音', type: 'boolean', default: false },
    ],
    cancellation: false,
    evidence: 'candidate',
    evidenceNote: '本地 fixture 能力，仅用于隔离测试；不代表任何真实模型。',
  });
}
