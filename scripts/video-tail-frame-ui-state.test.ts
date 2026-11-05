import assert from 'node:assert/strict';
import {
  collectVideoMotionReferenceAssetIds,
  collectVideoMotionTailImageIds,
  createVideoMotionRow,
  getVideoMotionRowIssue,
  getVideoMotionRowTailDraftState,
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

// ── 规格 §6：H3/Wan 自动模式的行级校验与序列化 ──────────────────────────
{
  // 自动模式三态：none / ready / pending。失败也算 pending——绝不能当成「没有尾帧」。
  assert.equal(getVideoMotionRowTailDraftState({ tailImageId: null, tailUploadState: 'idle' }), 'none');
  assert.equal(getVideoMotionRowTailDraftState({ tailImageId: 'tail', tailUploadState: 'idle' }), 'ready');
  for (const state of ['uploading', 'deleting'] as const) {
    assert.equal(getVideoMotionRowTailDraftState({ tailImageId: 'tail', tailUploadState: state }), 'pending', state);
  }
  assert.equal(
    getVideoMotionRowTailDraftState({ tailImageId: null, tailUploadState: 'failed' }),
    'pending',
    '上传失败时 tailImageId 暂空，也必须算 pending 而不是「没有尾帧」',
  );

  const autoTail = { supported: true as const, protocol: 'company-gateway-tencent-file-infos' };
  const autoOptions = { automaticMode: true };

  // 单图：允许提交，不带尾帧
  const single = { ...first, prompt: '运镜', tailImageId: null, tailUploadState: 'idle' as const };
  assert.equal(getVideoMotionRowIssue(single, autoTail, undefined, autoOptions), null);

  // 双图：允许提交，但提示词必须有
  const withTail = { ...single, tailImageId: 'tail-a' };
  assert.equal(getVideoMotionRowIssue(withTail, autoTail, undefined, autoOptions), null);
  assert.match(
    getVideoMotionRowIssue({ ...withTail, prompt: '' }, autoTail, undefined, autoOptions) ?? '',
    /提示词/,
  );

  // 上传中 / 删除中 / 失败：一律阻止提交
  for (const state of ['uploading', 'deleting'] as const) {
    assert.match(
      getVideoMotionRowIssue({ ...withTail, tailUploadState: state }, autoTail, undefined, autoOptions) ?? '',
      /等待尾帧/,
      state,
    );
  }
  const failed = { ...single, tailUploadState: 'failed' as const, tailUploadError: '网络断了' };
  assert.equal(getVideoMotionRowIssue(failed, autoTail, undefined, autoOptions), '网络断了');
  assert.match(
    getVideoMotionRowIssue({ ...single, tailUploadState: 'failed' as const }, autoTail, undefined, autoOptions) ?? '',
    /上传失败/,
  );

  // 切换供应商保留的参考素材不得静默丢弃：自动模式下明确告知不会提交
  const withLeftoverReference = { ...single, referenceAssets: [referenceImage('leftover')] };
  assert.match(
    getVideoMotionRowIssue(withLeftoverReference, autoTail, referenceCapability, autoOptions) ?? '',
    /参考素材不会提交/,
  );

  // 自动模式不受可能过期的参考能力快照影响（不误挡合法双图行）
  assert.equal(
    getVideoMotionRowIssue(withTail, autoTail, { supported: false, reason: 'contract_unverified' }, autoOptions),
    null,
  );

  // 序列化：自动模式带意图标记与三态；非自动模式请求体保持原样（向后兼容）
  assert.deepEqual(
    serializeVideoGenerationFields(single, { automaticMode: true, autoTailState: 'none' }),
    { generationMode: 'image-to-video', referenceAssetIds: [], tailImageId: null, modeIntent: 'auto', autoTailState: 'none' },
  );
  assert.deepEqual(
    serializeVideoGenerationFields(withTail, { automaticMode: true, autoTailState: 'ready' }),
    { generationMode: 'image-to-video', referenceAssetIds: [], tailImageId: 'tail-a', modeIntent: 'auto', autoTailState: 'ready' },
  );
  assert.deepEqual(
    serializeVideoGenerationFields({ ...first, prompt: '旧草稿', tailImageId: 'tail-old' }),
    { generationMode: 'image-to-video', referenceAssetIds: [], tailImageId: 'tail-old' },
    '非自动模式序列化结果必须与本次改动前完全一致（不带自动意图字段）',
  );

  // 批量逐行分流：同行组里单图/双图各走各的；未完成的那一行整组阻止
  const autoRows = [
    { ...single, key: 'a', prompt: '单图行' },
    { ...withTail, key: 'b', prompt: '双图行' },
  ];
  const autoPlan = planBulkVideoGeneration(
    [{ shotId: 'shot-auto', rows: autoRows }],
    { rowIssue: (row) => getVideoMotionRowIssue(row as typeof first, autoTail, undefined, autoOptions) },
  );
  assert.equal(autoPlan.ready.length, 1);
  assert.equal(autoPlan.totalClips, 2, '两种模式的行都能进入同一批次');

  const blockedRows = [autoRows[0], { ...autoRows[1], tailUploadState: 'uploading' as const }];
  const blockedPlan = planBulkVideoGeneration(
    [{ shotId: 'shot-blocked', rows: blockedRows }],
    { rowIssue: (row) => getVideoMotionRowIssue(row as typeof first, autoTail, undefined, autoOptions) },
  );
  assert.equal(blockedPlan.ready.length, 0, '含未完成尾帧的批次不得提交');
  assert.match(blockedPlan.blocked[0].reason, /尾帧/);
}

console.log('video tail-frame and reference UI state tests passed');