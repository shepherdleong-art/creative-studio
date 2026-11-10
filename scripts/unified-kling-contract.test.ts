import assert from 'node:assert/strict';

import {
  UNIFIED_KLING3_ANCHOR_ID,
  UNIFIED_KLING3_CHANNELS,
  UNIFIED_KLING3_DISPLAY_NAME,
  UNIFIED_KLING3_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  trustedChannelModelsForUnifiedModel,
  trustedUnifiedModelForChannelModel,
  unifiedKlingAnchorProjection,
} from '../lib/media-core/unified-media/catalog.ts';
import {
  UnifiedKlingRequestError,
  freezeUnifiedKlingVideoRequest,
  unifiedKlingChannelSupports,
  unifiedKlingCompatibleChannels,
} from '../lib/media-core/unified-media/video-requests.ts';
import {
  projectTeamVideoModels,
} from '../lib/media-core/unified-media/video-model-list.ts';
import { actorModelAllowed, type ActorPolicy } from '../lib/media-core/execution/pools.ts';

assert.deepEqual(UNIFIED_KLING3_CHANNELS, [
  {
    channelKey: 'qiniu',
    providerTable: 'video_providers',
    providerId: 'company-qiniuyun-kling-3-0',
    model: 'qiniuyun/kling-3.0',
    priority: 0,
  },
  {
    channelKey: 'tencent',
    providerTable: 'video_providers',
    providerId: 'company-kling-3-0',
    model: 'kling-3.0',
    priority: 1,
  },
]);

const frozen = freezeUnifiedKlingVideoRequest({
  sourceImageId: 'image-first',
  tailImageId: 'image-tail',
  referenceAssetIds: [],
  prompt: '镜头缓慢推进，保持产品结构稳定',
  durationSec: 10,
  generationMode: 'image-to-video',
  multiShot: true,
  aspectRatio: '3:4',
  resolution: '1K',
});
assert.deepEqual(frozen, {
  unifiedModel: UNIFIED_KLING3_MODEL_KEY,
  ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
  sourceImageId: 'image-first',
  tailImageId: 'image-tail',
  referenceAssetIds: [],
  prompt: '镜头缓慢推进，保持产品结构稳定',
  durationSec: 10,
  generationMode: 'image-to-video',
  multiShot: true,
  aspectRatio: '3:4',
  resolution: '1K',
});
assert.deepEqual(
  unifiedKlingCompatibleChannels(frozen).map((channel) => channel.channelKey),
  ['qiniu', 'tencent'],
);
assert.equal(unifiedKlingChannelSupports(UNIFIED_KLING3_CHANNELS[0], frozen), true);
assert.equal(unifiedKlingChannelSupports(UNIFIED_KLING3_CHANNELS[1], frozen), true);

const fourK = freezeUnifiedKlingVideoRequest({
  sourceImageId: 'image-first',
  tailImageId: null,
  referenceAssetIds: [],
  prompt: '产品旋转展示',
  durationSec: 3,
  generationMode: 'image-to-video',
  multiShot: false,
  aspectRatio: '16:9',
  resolution: '4k',
});
assert.equal(fourK.resolution, '4K');
assert.deepEqual(
  unifiedKlingCompatibleChannels(fourK).map((channel) => channel.channelKey),
  ['tencent'],
  '七牛可灵只支持 1K，4K 必须是腾讯单通道',
);

assert.throws(
  () => freezeUnifiedKlingVideoRequest({
    sourceImageId: 'image-first',
    tailImageId: null,
    referenceAssetIds: [],
    prompt: '测试',
    durationSec: 16,
    generationMode: 'image-to-video',
    multiShot: true,
    aspectRatio: '3:4',
    resolution: '1K',
  }),
  (error: unknown) => error instanceof UnifiedKlingRequestError
    && error.code === 'unsupported_kling_combination',
);
assert.throws(
  () => freezeUnifiedKlingVideoRequest({
    sourceImageId: 'image-first',
    tailImageId: null,
    referenceAssetIds: ['asset-1'],
    prompt: '测试',
    durationSec: 5,
    generationMode: 'image-to-video',
    multiShot: true,
    aspectRatio: '3:4',
    resolution: '1K',
  }),
  (error: unknown) => error instanceof UnifiedKlingRequestError
    && error.code === 'unsupported_kling_mode',
);
assert.throws(
  () => freezeUnifiedKlingVideoRequest({
    sourceImageId: 'image-first',
    tailImageId: null,
    referenceAssetIds: [],
    prompt: '测试',
    durationSec: 5,
    generationMode: 'reference-to-video',
    multiShot: true,
    aspectRatio: '3:4',
    resolution: '1K',
  }),
  (error: unknown) => error instanceof UnifiedKlingRequestError
    && error.code === 'unsupported_kling_mode',
);

assert.equal(trustedUnifiedModelForChannelModel(UNIFIED_KLING3_MODEL_KEY), UNIFIED_KLING3_MODEL_KEY);
assert.equal(trustedUnifiedModelForChannelModel('qiniuyun/kling-3.0'), UNIFIED_KLING3_MODEL_KEY);
assert.equal(trustedUnifiedModelForChannelModel('kling-v3'), null, '直连 kling-v3 不自动并入公司统一模型');
assert.deepEqual(
  trustedChannelModelsForUnifiedModel(UNIFIED_KLING3_MODEL_KEY),
  ['qiniuyun/kling-3.0', 'kling-3.0'],
);

const policy = (allowedModels: string[] | null): ActorPolicy => ({
  actorId: 'actor-1',
  monthlyLimitMinor: null,
  currency: 'CNY',
  personalConcurrency: 1,
  concurrencyMode: 'fixed',
  concurrencySource: 'personal_fixed',
  effectiveConcurrency: 1,
  paused: false,
  allowedModels,
  timezone: 'Asia/Shanghai',
  version: 1,
});
assert.equal(actorModelAllowed(policy([UNIFIED_KLING3_MODEL_KEY]), {
  unifiedModel: UNIFIED_KLING3_MODEL_KEY,
}), true);
assert.equal(actorModelAllowed(policy(['kling-3.0']), {
  model: 'qiniuyun/kling-3.0',
}), true);
assert.equal(actorModelAllowed(policy(['qiniuyun/kling-3.0']), {
  unifiedModel: UNIFIED_KLING3_MODEL_KEY,
}), true);
assert.equal(actorModelAllowed(policy(['kling-v3']), {
  unifiedModel: UNIFIED_KLING3_MODEL_KEY,
}), false);

const anchor = unifiedKlingAnchorProjection(true);
assert.equal(anchor.id, UNIFIED_KLING3_ANCHOR_ID);
assert.equal(anchor.name, UNIFIED_KLING3_DISPLAY_NAME);
assert.equal(anchor.defaultModel, UNIFIED_KLING3_MODEL_KEY);
assert.equal(anchor.type, 'openai-video');
assert.equal(JSON.stringify(anchor).includes('apiKey'), false);
assert.equal(JSON.stringify(anchor).includes('baseUrl'), false);

const other = {
  id: 'other-video',
  name: '其他视频模型',
  category: 'video',
};
const projected = projectTeamVideoModels([
  { ...other },
  { id: UNIFIED_KLING3_CHANNELS[0].providerId, name: '七牛真实通道', category: 'video' },
  { id: UNIFIED_KLING3_CHANNELS[1].providerId, name: '腾讯真实通道', category: 'video' },
], {
  mode: 'server',
  unifiedAvailable: true,
  unifiedCapabilities: { durations: [3, 5, 10] },
});
assert.deepEqual(
  projected.map((provider) => provider.id),
  [UNIFIED_KLING3_ANCHOR_ID, 'other-video'],
  'server 只显示统一可灵入口和其他视频模型，隐藏两个真实通道',
);
const localProjected = projectTeamVideoModels([
  { ...other },
  { id: UNIFIED_KLING3_CHANNELS[0].providerId, name: '七牛真实通道', category: 'video' },
  { id: UNIFIED_KLING3_CHANNELS[1].providerId, name: '腾讯真实通道', category: 'video' },
  { ...anchor, category: 'video' },
], {
  mode: 'local',
  unifiedAvailable: false,
  unifiedCapabilities: {},
});
assert.equal(localProjected.some((provider) => provider.id === UNIFIED_KLING3_ANCHOR_ID), false);
assert.equal(localProjected.some((provider) => provider.id === UNIFIED_KLING3_CHANNELS[0].providerId), true);

console.log('unified Kling contract tests passed');
