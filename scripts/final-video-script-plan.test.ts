import assert from 'node:assert/strict';
import { parseScriptPlan } from '../lib/final-video/script-plan.ts';

// v2：直接读 segments，保持叙事顺序
{
  const plan = parseScriptPlan(JSON.stringify({
    version: 2,
    segments: [
      { shotId: 's3', imageAssetId: 'i3', narration: '句A', subtitle: '字A', rationale: 'r3' },
      { shotId: 's1', imageAssetId: 'i1', narration: '句B', subtitle: '字B', rationale: 'r1' },
    ],
    droppedShots: [{ shotId: 's2', reason: '重复构图' }],
  }));
  assert.equal(plan.legacy, false);
  assert.deepEqual(plan.segments.map((s) => s.shotId), ['s3', 's1']);
  assert.deepEqual(plan.segments.map((s) => s.imageAssetId), ['i3', 'i1']);
  assert.equal(plan.segments[0].subtitle, '字A');
  assert.deepEqual(plan.droppedShotIds, ['s2']);
}

// 旧格式：shots[] 按原顺序读成 segments，imageAssetId 为 null（不做过期检测）
{
  const plan = parseScriptPlan(JSON.stringify({
    shots: [
      { shotId: 's1', voiceover: '老句A', subtitle: '老字A' },
      { shotId: 's2', voiceover: '老句B' },
      { shotId: 's3', voiceover: '' },   // 空口播的旧分镜要被跳过
    ],
    fullScript: '老句A老句B',
  }));
  assert.equal(plan.legacy, true);
  assert.deepEqual(plan.segments.map((s) => s.shotId), ['s1', 's2']);
  assert.deepEqual(plan.segments.map((s) => s.imageAssetId), [null, null]);
  assert.equal(plan.segments[0].subtitle, '老字A');
  assert.equal(plan.segments[1].subtitle, '老句B');  // subtitle 缺省回落到 voiceover
  assert.deepEqual(plan.droppedShotIds, []);
}

// 两种格式都没有可用句子 → 抛可辨识错误
{
  assert.throws(() => parseScriptPlan(JSON.stringify({ version: 2, segments: [] })), /脚本内容为空/);
  assert.throws(() => parseScriptPlan(JSON.stringify({ shots: [] })), /脚本内容为空/);
}

// outputJson 本身不是合法 JSON → JSON.parse 原样抛出 SyntaxError，不被吞成"空脚本"的 invalid_input
{
  assert.throws(() => parseScriptPlan('{not valid json'), SyntaxError);
}

// 合法 JSON 但顶层不是对象（null/数组/原始值）→ 按"空脚本"报错，而不是抛未过滤的 TypeError
{
  assert.throws(() => parseScriptPlan('null'), /脚本内容为空/);
  assert.throws(() => parseScriptPlan('[]'), /脚本内容为空/);
  assert.throws(() => parseScriptPlan('42'), /脚本内容为空/);
}

console.log('final-video script-plan: OK');
