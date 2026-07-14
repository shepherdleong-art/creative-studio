import assert from 'node:assert/strict';

const {
  canNavigateToScriptStep,
  getScriptStepStatus,
} = await import('../lib/script-workflow' + '.ts');

assert.deepEqual(
  getScriptStepStatus({ step: 1, hasAnalysis: false, hasScript: false }),
  {
    1: 'active',
    2: 'locked',
    3: 'locked',
  }
);

assert.deepEqual(
  getScriptStepStatus({ step: 3, hasAnalysis: true, hasScript: true }),
  {
    1: 'complete',
    2: 'complete',
    3: 'active',
  }
);

assert.equal(canNavigateToScriptStep(1, { hasAnalysis: false, hasScript: false }), true);
assert.equal(canNavigateToScriptStep(2, { hasAnalysis: true, hasScript: false }), true);
assert.equal(canNavigateToScriptStep(3, { hasAnalysis: true, hasScript: true }), true);

assert.equal(canNavigateToScriptStep(2, { hasAnalysis: false, hasScript: true }), false);
assert.equal(canNavigateToScriptStep(3, { hasAnalysis: true, hasScript: false }), false);

// ── v2 归一化：不再强制 1:1，选子集 + 未选进 droppedShots ──
{
  const { normalizeScriptOutput } = await import('../app/api/projects/[id]/script/normalize.ts');

  const shotRows = [
    { shotId: 's1', indexNum: 1, imageAssetId: 'img1' },
    { shotId: 's2', indexNum: 2, imageAssetId: 'img2' },
    { shotId: 's3', indexNum: 3, imageAssetId: 'img3' },
  ];

  // 模型只选了 2 张（s3 在前、s1 在后），s2 没提到
  const raw = {
    title: 'T',
    segments: [
      { shotId: 's3', narration: '句A', subtitle: '字A', rationale: '理由A' },
      { shotId: 's1', narration: '句B', subtitle: '字B', rationale: '理由B' },
    ],
    droppedShots: [],
  };

  const script = normalizeScriptOutput(raw, shotRows, 'set-1', 20);

  assert.equal(script.version, 2);
  // 顺序保持模型给的叙事顺序，不被强制成 indexNum 序
  assert.deepEqual(script.segments.map((s) => s.shotId), ['s3', 's1']);
  // imageAssetId 由服务端按 shotId 回填
  assert.deepEqual(script.segments.map((s) => s.imageAssetId), ['img3', 'img1']);
  // 未提及的 s2 自动补进 droppedShots
  assert.deepEqual(script.droppedShots.map((d) => d.shotId), ['s2']);
  // fullScript 由 narration 派生
  assert.equal(script.fullScript, '句A句B');
  assert.equal(script.targetDurationSec, 20);
}

// ── v2 归一化：非法 shotId 丢弃、重复 shotId 去重 ──
{
  const { normalizeScriptOutput } = await import('../app/api/projects/[id]/script/normalize.ts');
  const shotRows = [{ shotId: 's1', indexNum: 1, imageAssetId: 'img1' }];

  const script = normalizeScriptOutput({
    segments: [
      { shotId: 'BOGUS', narration: '不该活下来', subtitle: '', rationale: '' },
      { shotId: 's1', narration: '句A', subtitle: '', rationale: '' },
      { shotId: 's1', narration: '重复的', subtitle: '', rationale: '' },
    ],
    droppedShots: [],
  }, shotRows, 'set-1', 15);

  assert.deepEqual(script.segments.map((s) => s.shotId), ['s1']);
  assert.equal(script.segments[0].subtitle, '句A'); // subtitle 缺省回落到 narration
}

// ── v2 归一化：segments 全空要抛错（不能静默产出空片子）──
{
  const { normalizeScriptOutput } = await import('../app/api/projects/[id]/script/normalize.ts');
  assert.throws(
    () => normalizeScriptOutput({ segments: [], droppedShots: [] }, [{ shotId: 's1', indexNum: 1, imageAssetId: 'img1' }], 'set-1', 15),
    /没有产出任何画面/,
  );
}

console.log('script-workflow v2 normalization: OK');
