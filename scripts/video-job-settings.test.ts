/**
 * 08 号票：「这条视频用的设置」纯逻辑的单测。
 *
 * 覆盖验收要求的三条：
 *  - 点不同视频，右栏换成各自保存的设置（`savedSettingsFromJob` 读的是各任务行自己的字段）；
 *  - 改动后出现提示（`videoSettingsDiffer` 逐字段比较，任一字段不同即为改过）；
 *  - 点还原恢复原值（基线 → 草稿，`videoSettingsDiffer` 随之变回 false）。
 */
import assert from 'node:assert/strict';
import {
  VIDEO_SETTINGS_CHANGED_HINT,
  describeSavedSettings,
  savedSettingsFromJob,
  videoSettingsDiffer,
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

// 没改动 → 不显示「改过了」。
const unchanged = {
  prompt: jobA.prompt,
  providerId: jobA.providerId,
  durationSec: jobA.durationSec,
  templateId: jobA.templateId,
  multiShot: true,
  generationMode: 'image-to-video' as const,
  tailImageId: jobA.tailImageId,
};
assert.equal(videoSettingsDiffer(savedA, unchanged), false, '原样不动时不能提示改过');

// 任一字段改动 → 提示。
for (const patch of [
  { prompt: `${jobA.prompt}（追加）` },
  { providerId: 'provider-other' },
  { durationSec: 6 },
  { templateId: 'template-orbit' },
  { multiShot: false },
  { tailImageId: null },
]) {
  assert.equal(
    videoSettingsDiffer(savedA, { ...unchanged, ...patch }),
    true,
    `改动 ${Object.keys(patch)[0]} 后必须提示改过了`,
  );
}
// 提示文案是验收逐字比对的那一句。
assert.equal(VIDEO_SETTINGS_CHANGED_HINT, '改过了，再生成会多做一条，原来那条不变');

// 还原 = 把基线写回草稿 → 提示消失。
const reverted = { ...unchanged };
assert.equal(videoSettingsDiffer(savedA, reverted), false, '还原后不再提示');

// 全能参考模式比较的是参考素材列表（顺序也算），不比较尾帧。
const refDraft = {
  prompt: jobB.prompt,
  providerId: jobB.providerId,
  durationSec: jobB.durationSec,
  templateId: jobB.templateId,
  multiShot: false,
  generationMode: 'reference-to-video' as const,
  tailImageId: null,
  referenceAssetIds: ['ref-1', 'ref-2'],
};
assert.equal(videoSettingsDiffer(savedB, refDraft), false);
assert.equal(videoSettingsDiffer(savedB, { ...refDraft, referenceAssetIds: ['ref-2', 'ref-1'] }), true, '参考素材顺序变了也算改过');
assert.equal(videoSettingsDiffer(savedB, { ...refDraft, referenceAssetIds: ['ref-1'] }), true, '少一份参考素材也算改过');
// 首尾帧模式忽略参考素材差异（两套草稿互不影响）。
assert.equal(
  videoSettingsDiffer(savedA, { ...unchanged, referenceAssetIds: ['ref-9'] }),
  false,
  '首尾帧模式下参考素材不参与提交，不该误报改过',
);
// 提示词前后空白不算改动（提交时会 trim）。
assert.equal(videoSettingsDiffer(savedA, { ...unchanged, prompt: `  ${jobA.prompt}  ` }), false);

// 右栏摘要逐项来自保存字段。
const summaryA = describeSavedSettings(savedA);
assert.deepEqual(summaryA.map((item) => item.label), ['模型', '秒数', '首尾帧', '智能分镜']);
assert.deepEqual(summaryA.map((item) => item.value), ['kling-2.5', '5 秒', '带尾帧', '开']);
assert.deepEqual(
  describeSavedSettings(savedB).map((item) => item.value),
  ['doubao-seedance-2-5', '12 秒', '全能参考（当前分镜图）', '关'],
);

console.log('video-job-settings tests passed');
