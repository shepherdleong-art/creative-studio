import assert from 'node:assert/strict';
import {
  collectVideoMotionTailImageIds,
  createVideoMotionRow,
  getVideoMotionRowIssue,
  removeVideoMotionRowByKey,
  updateVideoMotionRowByKey,
} from '../components/video-tail-frame-state.ts';

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

console.log('video tail-frame UI state tests passed');
