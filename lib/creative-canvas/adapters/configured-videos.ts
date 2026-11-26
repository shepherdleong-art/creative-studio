import type Database from 'better-sqlite3';
import type { CanvasModelCapability } from '../capabilities.ts';
import { COMPANY_CANVAS_CAPABILITIES, COMPANY_CANVAS_KLING_3_0_CAPABILITY, COMPANY_CANVAS_SEEDANCE_2_0_CANDIDATE } from './company-capabilities.ts';
import { companyVideoCapsForModel } from '../../company-gateway-size.ts';
import { SEEDANCE_20, SEEDANCE_25, SEEDANCE_FAST } from '../../video-providers/seedance-contract.ts';
import { directSeedanceCapability } from './seedance-capabilities.ts';
import { UNIFIED_KLING3_ANCHOR_ID } from '../../media-core/unified-media/catalog.ts';
import {
  QINIU_KLING_4_CANVAS_ASPECT_RATIOS, QINIU_KLING_4_IMAGE_MAX_BYTES, QINIU_KLING_4_IMAGE_MIME_TYPES,
  QINIU_KLING_4_MAX_MIDDLE_FRAMES, QINIU_KLING_4_MODEL, QINIU_KLING_4_PROVIDER_ID,
  QINIU_KLING_4_PROVIDER_NAME, QINIU_KLING_4_DEFAULT_RESOLUTION, QINIU_KLING_4_RESOLUTIONS,
} from '../../company-qiniu-kling-4.ts';
import { videoReferenceCapability, type SupportedVideoReferenceCapability } from '../../video-reference-contract.ts';
import { videoDurationOptions } from '../../video-duration.ts';

const kling25: CanvasModelCapability = {
  ...COMPANY_CANVAS_KLING_3_0_CAPABILITY,
  key: 'company-kling-2-5', providerIdentity: 'company-kling-2-5',
  modelAlias: 'kling-2.5', displayName: '公司可灵 2.5',
  parameters: [
    { key: 'durationSec', label: '时长（秒）', type: 'enum', options: ['5', '10'], default: '5' },
    { key: 'resolution', label: '分辨率', type: 'enum', options: ['1080p'], default: '1080p' },
    { key: 'aspectRatio', label: '比例', type: 'enum', options: companyVideoCapsForModel('kling-2.5')!.ratios, default: '16:9' },
  ],
  evidenceNote: '沿用主工作台 Kling 2.5 的 OutputConfig 1080P、5/10 秒与 LastFrameUrl 合同；画布本地请求回归通过，首尾帧真实生成仍待验证。',
};

const kling4Reference = videoReferenceCapability('openai-video', QINIU_KLING_4_MODEL) as SupportedVideoReferenceCapability;

const kling4: CanvasModelCapability = {
  key: QINIU_KLING_4_PROVIDER_ID,
  providerIdentity: QINIU_KLING_4_PROVIDER_ID,
  displayName: QINIU_KLING_4_PROVIDER_NAME,
  providerKind: 'company',
  modelAlias: QINIU_KLING_4_MODEL,
  mediaKind: 'video',
  modes: ['image-to-video', 'frames-to-video', 'reference-to-video'],
  mediaInputMinimums: [{ modes: ['reference-to-video'], min: 1 }],
  modeLabels: { 'frames-to-video': '多关键帧', 'reference-to-video': '全能参考' },
  modeHints: {
    'image-to-video': '按顺序接入首帧及可选尾帧。自动跟随首帧，选定比例后居中裁切上传副本。',
    'frames-to-video': '按顺序接入 3–10 张图片。自动跟随首帧，选定比例后居中裁切上传副本。',
    'reference-to-video': '图片和视频可混用。选 3:4 时，先把参考图居中裁成 3:4 再生成。带图任务若返回横片，会保留完整画面。仅用视频参考时，成片按需居中裁切。',
  },
  inputs: [
    { kind: 'image', roles: ['first-frame'], min: 1, max: 1, modes: ['image-to-video', 'frames-to-video'] },
    { kind: 'image', roles: ['middle-frame'], min: 1, max: QINIU_KLING_4_MAX_MIDDLE_FRAMES,
      mimeTypes: QINIU_KLING_4_IMAGE_MIME_TYPES, maxBytes: QINIU_KLING_4_IMAGE_MAX_BYTES, modes: ['frames-to-video'] },
    { kind: 'image', roles: ['last-frame'], min: 0, max: 1, modes: ['image-to-video', 'frames-to-video'] },
    { kind: 'image', roles: ['reference', 'subject', 'product', 'style', 'scene'], min: 0, max: kling4Reference.image.maxCount, mimeTypes: kling4Reference.image.mimeTypes, maxBytes: kling4Reference.image.maxBytes, modes: ['reference-to-video'] },
    { kind: 'video', roles: ['reference', 'camera'], min: 0, max: kling4Reference.video.maxCount, mimeTypes: kling4Reference.video.mimeTypes, maxBytes: kling4Reference.video.maxBytes, maxDurationSec: kling4Reference.video.maxDurationSec, modes: ['reference-to-video'] },
    { kind: 'text', roles: ['reference'], min: 0, max: 1 },
  ],
  parameters: [
    { key: 'durationSec', label: '时长（秒）', type: 'enum', options: videoDurationOptions('openai-video', QINIU_KLING_4_MODEL).map(String), default: '5' },
    { key: 'resolution', label: '分辨率', type: 'enum', options: [...QINIU_KLING_4_RESOLUTIONS], default: QINIU_KLING_4_DEFAULT_RESOLUTION },
    { key: 'aspectRatio', label: '比例', type: 'enum', options: QINIU_KLING_4_CANVAS_ASPECT_RATIOS, default: '16:9', modes: ['reference-to-video'] },
    { key: 'frameAspectRatio', label: '比例', type: 'enum', options: QINIU_KLING_4_CANVAS_ASPECT_RATIOS, default: 'adaptive', modes: ['image-to-video', 'frames-to-video'] },
  ],
  cancellation: false,
  evidence: 'mapped',
  evidenceNote: '七牛可灵 4.0 已在公司网关验证 720p 单首帧、首尾帧、多关键帧和图加视频参考。',
};

const SPECS = [...COMPANY_CANVAS_CAPABILITIES.filter((capability) => capability.mediaKind === 'video'), COMPANY_CANVAS_SEEDANCE_2_0_CANDIDATE, kling25, kling4];

export function configuredCanvasVideos(db: Database.Database): CanvasModelCapability[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'video_providers'").get()) return [];
  const rows = db.prepare(`SELECT id, name, defaultModel FROM video_providers
    WHERE type = 'openai-video' AND enabled = 1 AND length(trim(baseUrl)) > 0 AND length(trim(apiKey)) > 0
    ORDER BY name, id`).all() as Array<{ id: string; name: string; defaultModel: string }>;
  const capabilities: CanvasModelCapability[] = rows.flatMap((row) => {
    if (row.id === UNIFIED_KLING3_ANCHOR_ID) return [];
    const spec = SPECS.find((entry) => entry.modelAlias === row.defaultModel);
    if (!spec) return [];
    const key = row.id === spec.providerIdentity ? spec.key : `${spec.key}:provider:${encodeURIComponent(row.id)}`;
    if (row.defaultModel === SEEDANCE_20 || row.defaultModel === SEEDANCE_25 || row.defaultModel === SEEDANCE_FAST) {
      return [{ ...directSeedanceCapability(row.defaultModel),
        key: `${key}:ark-v1`, providerKind: 'company' as const, providerIdentity: row.id, displayName: row.name,
        evidenceNote: '用户确认公司网关支持方舟原生协议；复用直连六模式与参数校验，媒体强制 COS，画布真实生成尚未验收。',
      }];
    }
    return [{ ...spec, key,
      providerIdentity: row.id, displayName: row.name,
    }];
  });
  // 比较只在数据库内完成，避免把凭据带入能力对象或 API。
  const equivalent = db.prepare(`SELECT a.id AS sourceId, b.id AS targetId
    FROM video_providers a JOIN video_providers b
      ON a.type = b.type AND a.defaultModel = b.defaultModel
      AND RTRIM(TRIM(a.baseUrl), '/') = RTRIM(TRIM(b.baseUrl), '/') AND a.apiKey = b.apiKey
    WHERE a.type = 'openai-video' AND a.enabled = 1 AND b.enabled = 1`).all() as Array<{ sourceId: string; targetId: string }>;
  return capabilities.map((capability) => {
    const ids = new Set(equivalent.filter(pair => pair.sourceId === capability.providerIdentity).map(pair => pair.targetId));
    const matches = capabilities.filter(candidate => ids.has(candidate.providerIdentity));
    const builtinId = SPECS.find(spec => spec.modelAlias === capability.modelAlias)?.providerIdentity;
    const canonical = matches.find(candidate => candidate.providerIdentity === builtinId) ?? matches[0] ?? capability;
    return canonical.key === capability.key ? capability : {
      ...capability, selectionAliasOf: canonical.key, displayName: canonical.displayName,
    };
  });
}
