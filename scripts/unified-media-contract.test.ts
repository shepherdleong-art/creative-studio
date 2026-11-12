import assert from 'node:assert/strict';

import {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_CHANNELS,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  unifiedImageAnchorProjection,
  unifiedImageCatalogCombinations,
  unifiedImageCompatibleChannels,
  unifiedImageResolutionsForRatio,
  unifiedImageSupports,
  trustedUnifiedModelForChannelModel,
} from '../lib/media-core/unified-media/catalog.ts';
import { projectTeamImageModels } from '../lib/media-core/unified-media/model-list.ts';
import {
  UnifiedImageRequestError,
  freezeUnifiedImageRequest,
  inferUnifiedImageOutputFromPreset,
} from '../lib/media-core/unified-media/requests.ts';
import { actorModelAllowed } from '../lib/media-core/execution/pools.ts';
import type { ActorPolicy } from '../lib/media-core/execution/pools.ts';

assert.equal(UNIFIED_MEDIA_RULE_VERSION, 'unified-media-2026-11-10-v1');
assert.equal(UNIFIED_IMAGE_MODEL_KEY, 'image2');
assert.equal(UNIFIED_IMAGE_ANCHOR_ID, 'unified-image2');

assert.deepEqual(UNIFIED_IMAGE_CHANNELS, [
  {
    channelKey: 'qiniu',
    providerTable: 'providers',
    providerId: 'company-gateway-qiniuyun-gpt-image-2-medium',
    model: 'qiniuyun/gpt-image-2-medium',
    priority: 0,
  },
  {
    channelKey: 'tencent',
    providerTable: 'providers',
    providerId: 'company-gateway-image2-medium',
    model: 'image2-medium',
    priority: 1,
  },
]);

const qiniu = UNIFIED_IMAGE_CHANNELS[0];
const tencent = UNIFIED_IMAGE_CHANNELS[1];

assert.equal(unifiedImageSupports(qiniu, '2k', '9:16'), true);
assert.equal(unifiedImageSupports(qiniu, '2k', '3:4'), true);
assert.equal(unifiedImageSupports(qiniu, '1k', '1:1'), false);
assert.equal(unifiedImageSupports(qiniu, '4k', '3:4'), true, '4K 3:4 is now verified as a direct qiniu cell');
assert.equal(unifiedImageSupports(tencent, '1k', '1:1'), true);
assert.equal(unifiedImageSupports(tencent, '1k', '9:16'), true);

const combinations = unifiedImageCatalogCombinations();
assert.equal(combinations.length, 36, 'the UI catalog is the union of executable channel cells, not tier × ratio cross-products');
assert.equal(combinations.some((item) => item.tier === '1k' && item.ratio === '9:16'), true);
assert.deepEqual(
  unifiedImageResolutionsForRatio('9:16'),
  ['1k', '2k', '4k'],
  '9:16 is available only where at least one exact channel supports the complete cell',
);
assert.deepEqual(
  unifiedImageCompatibleChannels('1k', '9:16').map((channel) => channel.channelKey),
  ['tencent'],
);
assert.deepEqual(
  unifiedImageCompatibleChannels('1k', '3:4').map((channel) => channel.channelKey),
  ['tencent'],
);
assert.deepEqual(
  unifiedImageCompatibleChannels('2k', '3:4').map((channel) => channel.channelKey),
  ['qiniu', 'tencent'],
);
assert.deepEqual(
  unifiedImageCompatibleChannels('4k', '3:4').map((channel) => channel.channelKey),
  ['qiniu', 'tencent'],
);

assert.throws(
  () => freezeUnifiedImageRequest({
    inputImageId: 'image-1',
    referenceImageIds: [],
    prompt: '保持产品不变，更换场景',
    tier: '4k',
    ratio: '2:1',
    referenceGuidanceMode: 'none',
  }),
  (error: unknown) => error instanceof UnifiedImageRequestError
    && error.code === 'unsupported_image_combination',
);

for (const ratio of ['5:4', '4:5']) {
  assert.deepEqual(unifiedImageResolutionsForRatio(ratio), ['1k', '2k', '4k']);
  assert.deepEqual(unifiedImageCompatibleChannels('4k', ratio).map((channel) => channel.channelKey), ['tencent']);
}
for (const ratio of ['2:1', '1:2', '9:21']) {
  assert.deepEqual(unifiedImageResolutionsForRatio(ratio), ['1k', '2k']);
  assert.deepEqual(unifiedImageCompatibleChannels('2k', ratio).map((channel) => channel.channelKey), ['tencent']);
  assert.deepEqual(unifiedImageCompatibleChannels('4k', ratio), []);
}
assert.deepEqual(unifiedImageCompatibleChannels('4k', '9:16').map((channel) => channel.channelKey), ['qiniu', 'tencent']);

const frozen = freezeUnifiedImageRequest({
  inputImageId: 'image-1',
  referenceImageIds: ['image-2', 'image-3'],
  prompt: '保持图1产品不变，参考图2-3调整场景',
  tier: '2k',
  ratio: '3:4',
  referenceGuidanceMode: 'preserve_subject',
});
assert.deepEqual(frozen, {
  unifiedModel: 'image2',
  ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
  inputImageId: 'image-1',
  referenceImageIds: ['image-2', 'image-3'],
  prompt: '保持图1产品不变，参考图2-3调整场景',
  tier: '2k',
  ratio: '3:4',
  size: '1728x2304',
  quality: 'auto',
  referenceGuidanceMode: 'preserve_subject',
});
assert.deepEqual(inferUnifiedImageOutputFromPreset('1728x2304'), { tier: '2k', ratio: '3:4' });
assert.deepEqual(inferUnifiedImageOutputFromPreset('1024x1024'), { tier: '1k', ratio: '1:1' });
assert.equal(inferUnifiedImageOutputFromPreset('not-a-preset'), null);

assert.equal(trustedUnifiedModelForChannelModel('image2-medium'), 'image2');
assert.equal(trustedUnifiedModelForChannelModel('qiniuyun/gpt-image-2-medium'), 'image2');
assert.equal(trustedUnifiedModelForChannelModel('image2-medium-preview'), null);
assert.equal(trustedUnifiedModelForChannelModel('qiniuyun/gpt-image-2-medium-extra'), null);

const projection = unifiedImageAnchorProjection(true);
assert.deepEqual(projection, {
  id: UNIFIED_IMAGE_ANCHOR_ID,
  name: 'Image 2',
  model: 'image2',
  type: 'unified-image',
  category: 'image',
  enabled: 1,
  configured: true,
  hasApiKey: true,
  missing: [],
  unified: true,
  ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
});
assert.equal(JSON.stringify(projection).includes('apiKey'), false, 'model projection must never expose credentials');
assert.equal(JSON.stringify(projection).includes('baseUrl'), false, 'model projection must never expose upstream addresses');
assert.equal(unifiedImageAnchorProjection(false).hasApiKey, false);

const imageRows = [
  {
    id: UNIFIED_IMAGE_ANCHOR_ID, name: 'Image 2', model: 'image2', type: 'unified-image',
    enabled: 1, apiKey: '', baseUrl: '',
  },
  {
    id: 'company-gateway-image2-medium', name: '腾讯 Image 2', model: 'image2-medium',
    type: 'gateway-task-image', enabled: 1, apiKey: 'secret', baseUrl: 'https://internal.example',
  },
  {
    id: 'company-gateway-qiniuyun-gpt-image-2-medium', name: '七牛 Image 2',
    model: 'qiniuyun/gpt-image-2-medium', type: 'gateway-task-image',
    enabled: 1, apiKey: 'secret', baseUrl: 'https://internal.example',
  },
  {
    id: 'company-gateway-seedream-5-0-pro', name: '公司 Seedream 5.0 Pro',
    model: 'doubao-seedream-5-0-pro-image', type: 'gateway-task-image',
    enabled: 1, apiKey: 'secret', baseUrl: 'https://internal.example',
  },
  {
    id: 'company-gateway-nano-banana-pro', name: '公司 Nano Banana Pro',
    model: 'nano-banana-3.0', type: 'gateway-task-image',
    enabled: 1, apiKey: 'secret', baseUrl: 'https://internal.example',
  },
  {
    id: 'packy-gpt-image-2', name: '已退休', model: 'gpt-image-2', type: 'packy-images',
    enabled: 1, apiKey: 'secret', baseUrl: 'https://public.example',
  },
];
const serverModels = projectTeamImageModels(imageRows, { mode: 'server', unifiedAvailable: true });
assert.deepEqual(serverModels.map((model) => model.id), [
  UNIFIED_IMAGE_ANCHOR_ID,
  'company-gateway-seedream-5-0-pro',
  'company-gateway-nano-banana-pro',
]);
assert.deepEqual(
  projectTeamImageModels(imageRows, { mode: 'local', unifiedAvailable: false }).map((model) => model.id),
  [
    'company-gateway-image2-medium',
    'company-gateway-qiniuyun-gpt-image-2-medium',
    'company-gateway-seedream-5-0-pro',
    'company-gateway-nano-banana-pro',
  ],
  'local mode keeps the original provider list and hides the unified anchor',
);
assert.equal(JSON.stringify(serverModels).includes('apiKey'), false);
assert.equal(JSON.stringify(serverModels).includes('baseUrl'), false);

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

assert.equal(actorModelAllowed(policy(['image2']), { unifiedModel: 'image2' }), true);
assert.equal(actorModelAllowed(policy(['image2']), { model: 'image2-medium' }), true);
assert.equal(actorModelAllowed(policy(['image2']), { model: 'qiniuyun/gpt-image-2-medium' }), true);
assert.equal(actorModelAllowed(policy(['image2-medium']), { unifiedModel: 'image2' }), true);
assert.equal(actorModelAllowed(policy(['qiniuyun/gpt-image-2-medium']), { unifiedModel: 'image2' }), true);
assert.equal(actorModelAllowed(policy(['image2']), { model: 'image2-medium-preview' }), false);
assert.equal(
  actorModelAllowed(policy(['image2-medium']), { model: 'qiniuyun/gpt-image-2-medium' }),
  true,
  'one trusted Image 2 channel grant maps to the unified model and covers the other exact channel',
);
assert.equal(actorModelAllowed(policy(['seedream']), { unifiedModel: 'image2' }), false);
assert.equal(actorModelAllowed(policy(null), { unifiedModel: 'image2' }), true);

console.log('unified media contract tests passed');
