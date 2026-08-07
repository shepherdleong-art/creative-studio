import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { splitBatchScriptSentences } from '../lib/batch-production/script-sentences.ts';
import { splitAllocationScriptBody } from '../lib/batch-production/allocator.ts';
import { buildBatchNarrationSegments } from '../lib/batch-production/narration.ts';

function forms(bodyText: string) {
  const sentences = splitBatchScriptSentences(bodyText);
  return {
    withPunctuation: sentences.map(({ textWithPunctuation }) => textWithPunctuation),
    plain: sentences.map(({ text }) => text),
  };
}

// 1. 常规文本两种形态一一对应,句数一致
{
  assert.deepEqual(forms('A。B'), { withPunctuation: ['A。', 'B'], plain: ['A', 'B'] });
  assert.deepEqual(forms('A、B，C'), { withPunctuation: ['A、B，C'], plain: ['A、B，C'] }, '顿号与逗号不是终止标点,不算句界');
  assert.deepEqual(forms('A。\nB'), { withPunctuation: ['A。', 'B'], plain: ['A', 'B'] });
  assert.deepEqual(forms('A；B；'), { withPunctuation: ['A；', 'B；'], plain: ['A', 'B'] });
  assert.deepEqual(forms('A'), { withPunctuation: ['A'], plain: ['A'] }, '无终止标点只有一句');
}

// 2. 连续终止标点一律归前一句:2 句,textWithPunctuation 保留原标点
{
  assert.deepEqual(forms('A。。B'), { withPunctuation: ['A。。', 'B'], plain: ['A', 'B'] });
  assert.deepEqual(forms('A！？B'), { withPunctuation: ['A！？', 'B'], plain: ['A', 'B'] });
  assert.deepEqual(forms('A？？'), { withPunctuation: ['A？？'], plain: ['A'] }, '结尾的连续标点不产生多余句段');
}

// 3. 空串、纯标点、纯换行
{
  assert.deepEqual(forms(''), { withPunctuation: [], plain: [] });
  assert.deepEqual(forms('   '), { withPunctuation: [], plain: [] });
  assert.deepEqual(forms('。。。'), { withPunctuation: [], plain: [] }, '纯标点按去标点侧语义不产生句段');
  assert.deepEqual(forms('\n\n'), { withPunctuation: [], plain: [] });
}

// 4. 与分配器/口播侧的真实接线:两个导出函数句数永远一致
{
  const body = '周末午后，她窝在洒满阳光的客厅沙发里。坐着看书、贵妃位放腿，俩人并排躺也自在。软靠背和云座包稳稳托住身体，放松到不想起身。';
  const narrationSegments = buildBatchNarrationSegments('snap-g564', body);
  const allocationParts = splitAllocationScriptBody(body);
  assert.equal(narrationSegments.length, allocationParts.length, '口播句段与分配句段数量必须一致');
  assert.equal(narrationSegments.length, 3);
  assert.deepEqual(allocationParts, ['周末午后，她窝在洒满阳光的客厅沙发里', '坐着看书、贵妃位放腿，俩人并排躺也自在', '软靠背和云座包稳稳托住身体，放松到不想起身']);
}

// 5. 红线回归:现网 G564 那条真实 bodyText 的 3 个 stableSegmentId 与改动前逐字节相同
{
  const scriptSnapshotId = 'snapshot-g564-real';
  const body = '周末午后，她窝在洒满阳光的客厅沙发里。坐着看书、贵妃位放腿，俩人并排躺也自在。软靠背和云座包稳稳托住身体，放松到不想起身。';
  const expectedTexts = [
    '周末午后，她窝在洒满阳光的客厅沙发里。',
    '坐着看书、贵妃位放腿，俩人并排躺也自在。',
    '软靠背和云座包稳稳托住身体，放松到不想起身。',
  ];
  const segments = buildBatchNarrationSegments(scriptSnapshotId, body);
  for (let index = 0; index < expectedTexts.length; index += 1) {
    const expectedId = `batch-segment-${createHash('sha256').update(`${scriptSnapshotId}\u0000${index}\u0000${expectedTexts[index]}`).digest('hex').slice(0, 20)}`;
    assert.equal(segments[index].segmentId, expectedId, `句段 ${index} 的 id 不得因断句重构而变化`);
    assert.equal(segments[index].narration, expectedTexts[index], `句段 ${index} 带标点文本不得变化`);
  }
}

console.log('batch script-sentences tests passed');
