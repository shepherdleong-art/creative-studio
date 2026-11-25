/**
 * 08 号票：「这条视频用的设置」纯逻辑的单测。
 *
 * 验证右栏设置取自所选任务，以及历史任务的字段默认值。
 */
import assert from 'node:assert/strict';
import {
  describeSavedSettings,
  savedSettingsFromJob,
} from '../components/video-job-settings.ts';

const jobA = {
  prompt: '镜头推进，向主体缓慢靠近，运动平稳自然。',
  providerId: 'provider-kling25',
  model: 'kling-2.5',
  durationSec: 5,
  templateId: 'template-push',
  multiShot: 1,
  generationMode: 'image-to-video',
  tailImageId: 'tail-1',
  referenceAssetIds: [],
};
const jobB = {
  prompt: '镜头环绕，绕主体走一小段侧向弧线。',
  providerId: 'provider-seedance25',
  model: 'doubao-seedance-2-5',
  durationSec: 12,
  templateId: null,
  multiShot: 0,
  generationMode: 'reference-to-video',
  tailImageId: null,
  referenceAssetIds: ['ref-1', 'ref-2'],
};

const savedA = savedSettingsFromJob(jobA);
const savedB = savedSettingsFromJob(jobB);

// 点不同的视频 → 右栏是各自保存的设置（不是最后一行、也不是当前草稿）。
assert.notDeepEqual(savedA, savedB, '两条视频的设置必须不同');
assert.equal(savedA.model, 'kling-2.5');
assert.equal(savedB.model, 'doubao-seedance-2-5');
assert.equal(savedA.durationSec, 5);
assert.equal(savedB.durationSec, 12);
assert.equal(savedA.templateId, 'template-push');
assert.equal(savedB.templateId, '', 'templateId 为 NULL 时归一为空串（模板下拉的「自定义」）');
assert.equal(savedA.multiShot, true);
assert.equal(savedB.multiShot, false, 'multiShot=0 归一为 false');
assert.equal(savedA.tailImageId, 'tail-1');
assert.equal(savedB.generationMode, 'reference-to-video');
assert.deepEqual(savedB.referenceAssetIds, ['ref-1', 'ref-2']);

// 缺记录的字段按「未记录」保守处理，不猜。
assert.equal(savedSettingsFromJob({ ...jobA, multiShot: null }).multiShot, false, 'multiShot 未记录按关处理');
assert.equal(savedSettingsFromJob({ ...jobA, generationMode: null }).generationMode, 'image-to-video', '旧任务没有 generationMode 时按首尾帧');
assert.deepEqual(savedSettingsFromJob({ ...jobA, referenceAssetIds: null }).referenceAssetIds, []);

// 右栏摘要逐项来自保存字段。
const summaryA = describeSavedSettings(savedA);
assert.deepEqual(summaryA.map((item) => item.label), ['模型', '秒数', '首尾帧', '智能分镜']);
assert.deepEqual(summaryA.map((item) => item.value), ['kling-2.5', '5 秒', '带尾帧', '开']);
assert.deepEqual(
  describeSavedSettings(savedB).map((item) => item.value),
  ['doubao-seedance-2-5', '12 秒', '全能参考（2 份素材）', '关'],
);

const kling4 = { ...jobA, model: 'qiniuyun/kling-4.0' };
assert.equal(savedSettingsFromJob(kling4).resolution, '720p');
assert.equal(savedSettingsFromJob({ ...kling4, resolution: '1080p' }).resolution, '1080p');

console.log('video-job-settings tests passed');
