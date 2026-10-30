import assert from 'node:assert/strict';
import {
  collectVideoMotionReferenceAssetIds,
  collectVideoMotionTailImageIds,
  createVideoMotionRow,
  getVideoMotionRowIssue,
  removeVideoMotionRowByKey,
  reorderVideoReferenceAssets,
  updateVideoMotionRowByKey,
  type VideoReferenceAsset,
} from '../components/video-tail-frame-state.ts';
import {
  planBulkVideoGeneration,
  serializeVideoGenerationFields,
} from '../components/video-bulk-prompt.ts';

const first = createVideoMotionRow('row-a', 5);
const second = createVideoMotionRow('row-b', 8);

{
  const result = updateVideoMotionRowByKey([first, second], 'row-b', (row) => ({
    ...row,
    tailImageId: 'tail-b',
    tailImageUrl: '/api/images/tail-b.png',
  }));
  assert.equal(result.updated, true);
  assert.equal(result.rows[0].tailImageId, null, '异步上传不得写到相邻行');
  assert.equal(result.rows[1].tailImageId, 'tail-b');
}

{
  const result = updateVideoMotionRowByKey([first], 'removed-row', (row) => ({
    ...row,
    tailImageId: 'orphan-tail',
  }));
  assert.equal(result.updated, false, '上传完成前已删除的行不得被重新创建');
  assert.deepEqual(result.rows, [first]);
}

{
  const rows = removeVideoMotionRowByKey([first, second], 'row-a');
  assert.deepEqual(rows.map((row) => row.key), ['row-b']);
}

{
  const tailA = { ...first, tailImageId: 'tail-a' };
  const tailADuplicate = { ...second, tailImageId: 'tail-a' };
  const tailB = { ...second, key: 'row-c', tailImageId: 'tail-b' };
  assert.deepEqual(
    collectVideoMotionTailImageIds([[tailA], [tailADuplicate, tailB]]).sort(),
    ['tail-a', 'tail-b'],
    '切换分镜组或卸载时应收集并去重全部未提交尾帧',
  );
}

{
  const withTail = { ...first, prompt: '向前推进', tailImageId: 'tail-a' };
  assert.match(
    getVideoMotionRowIssue(withTail, { supported: false, reason: 'unsupported_model' }) ?? '',
    /不支持首尾帧/,
  );
  assert.equal(withTail.tailImageId, 'tail-a', '切换到不支持的模型时仍保留尾帧供用户移除');
  assert.match(
    getVideoMotionRowIssue({ ...withTail, prompt: '' }, { supported: true, protocol: 'ark-content-roles' }) ?? '',
    /提示词/,
  );
  assert.match(
    getVideoMotionRowIssue({ ...first, tailUploadState: 'uploading' }, { supported: true }) ?? '',
    /上传/,
  );
}

const referenceImage = (id: string): VideoReferenceAsset => ({
  id,
  kind: 'image',
  filename: `${id}.png`,
  mimeType: 'image/png',
  byteSize: 1024,
  durationSec: null,
  url: `/api/video-reference-assets/${id}`,
});
const referenceCapability = {
  supported: true as const,
  image: { maxCount: 2, mimeTypes: ['image/png'], maxBytes: 1024 * 1024 },
  video: {
    maxCount: 2,
    mimeTypes: ['video/mp4'],
    maxBytes: 1024 * 1024,
    minDurationSec: 2,
    maxDurationSec: 10,
    maxTotalDurationSec: 6,
  },
  audio: {
    maxCount: 2,
    mimeTypes: ['audio/mpeg'],
    maxBytes: 1024 * 1024,
    minDurationSec: 2,
    maxDurationSec: 10,
    maxTotalDurationSec: 6,
  },
  allowsAudioOnly: false,
  aspectRatios: ['16:9'],
  resolutions: ['1080p'],
  defaultResolution: '1080p',
};

{
  assert.equal(first.generationMode, 'image-to-video', '新草稿默认沿用首尾帧');
  assert.deepEqual(first.referenceAssets, []);
  assert.deepEqual(
    serializeVideoGenerationFields({ prompt: '旧草稿', tailImageId: 'tail-old', referenceAssets: [referenceImage('ref-old')] }),
    { generationMode: 'image-to-video', referenceAssetIds: [], tailImageId: 'tail-old' },
    '缺少 generationMode 的历史 fixture 仍按首尾帧序列化',
  );
}

{
  const refA = referenceImage('ref-a');
  const refB = referenceImage('ref-b');
  const reordered = reorderVideoReferenceAssets([refA, refB], 'ref-a', 1);
  assert.deepEqual(reordered.map((asset) => asset.id), ['ref-b', 'ref-a']);
  assert.deepEqual(
    serializeVideoGenerationFields({
      prompt: '参考生成',
      generationMode: 'reference-to-video',
      referenceAssets: reordered,
      tailImageId: '保留但不提交',
    }),
    { generationMode: 'reference-to-video', referenceAssetIds: ['ref-b', 'ref-a'], tailImageId: null },
    '参考 ID 必须按可见列表顺序提交，保留的尾帧不得混入参考请求',
  );
  assert.deepEqual(collectVideoMotionReferenceAssetIds([[{ ...first, referenceAssets: [refA, refA, refB] }]]), ['ref-a', 'ref-b']);
}

{
  const retained = {
    ...first,
    prompt: '参考生成',
    generationMode: 'reference-to-video' as const,
    referenceAssets: [referenceImage('retained')],
  };
  const issue = getVideoMotionRowIssue(retained, { supported: false }, { supported: false, reason: 'unsupported_model' });
  assert.match(issue ?? '', /不支持全能参考/);
  assert.match(issue ?? '', /参考素材已保留/);
  assert.equal(retained.referenceAssets[0].id, 'retained', '切换不支持模型不得删除草稿素材');
  assert.equal(getVideoMotionRowIssue(retained, { supported: false }, referenceCapability), null);
}

{
  const emptyReference = {
    ...first,
    prompt: '参考生成',
    generationMode: 'reference-to-video' as const,
    referenceAssets: [],
  };
  assert.equal(getVideoMotionRowIssue(emptyReference, { supported: false }, referenceCapability), null);
  const emptyPlan = planBulkVideoGeneration([{ shotId: 'shot-empty', rows: [emptyReference] }]);
  assert.equal(emptyPlan.ready.length, 1, '当前分镜原图直接作为参考');
  assert.equal(emptyPlan.blocked.length, 0);

  const uploading = { ...emptyReference, referenceAssets: [referenceImage('uploading')], referenceUploadState: 'uploading' as const };
  const uploadingPlan = planBulkVideoGeneration([{ shotId: 'shot-uploading', rows: [uploading] }]);
  assert.equal(uploadingPlan.ready.length, 0, '上传中的参考不得进入批量提交');
  assert.match(uploadingPlan.blocked[0].reason, /上传/);
}

{
  const tooMany = {
    ...first,
    prompt: '参考生成',
    generationMode: 'reference-to-video' as const,
    referenceAssets: [referenceImage('a'), referenceImage('b'), referenceImage('c')],
  };
  assert.match(getVideoMotionRowIssue(tooMany, { supported: false }, referenceCapability) ?? '', /最多 2 份/);
  const invalidSegment: VideoReferenceAsset = {
    ...referenceImage('short'),
    kind: 'video',
    mimeType: 'video/mp4',
    durationSec: 1,
  };
  assert.match(
    getVideoMotionRowIssue({ ...tooMany, referenceAssets: [invalidSegment] }, { supported: false }, referenceCapability) ?? '',
    /每段须为 2–10 秒/,
  );
  assert.match(
    getVideoMotionRowIssue(
      { ...tooMany, referenceAssets: [{ ...invalidSegment, id: 'v1', durationSec: 4 }, { ...invalidSegment, id: 'v2', durationSec: 4 }] },
      { supported: false },
      referenceCapability,
    ) ?? '',
    /总时长不能超过 6 秒/,
  );
}

console.log('video tail-frame and reference UI state tests passed');
