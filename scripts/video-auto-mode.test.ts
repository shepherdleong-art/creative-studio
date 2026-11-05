// 票 05：H3/Wan 自动模式的纯决策合同（规格 §6 四行状态表）。
//
// 这个文件只测**前端与服务端共用**的自动模式决策，不涉及数据库与网络；
// 创建/队列/适配器层面的核对分别在 video-reference-job-create.test.ts、
// video-queue-reference.test.ts、openai-video-adapter.test.ts 里覆盖。
import assert from 'node:assert/strict';
import {
  decideVideoGenerationMode,
  isVideoAutoModeTarget,
  videoTailFrameDraftState,
} from '../lib/video-auto-mode.ts';
import { resolveVideoGenerationSelection } from '../lib/video-generation-options.ts';

// ── 精确 allowlist：只有 openai-video + 两个精确模型 ──
for (const model of ['minimax-h3', 'wan-3.0']) {
  assert.equal(isVideoAutoModeTarget('openai-video', model), true, model);
}
for (const [type, model] of [
  ['jimeng', 'minimax-h3'],
  ['kling', 'wan-3.0'],
  ['openai-video', 'MiniMax-H3'],
  ['openai-video', 'minimax-h3-max'],
  ['openai-video', 'wan-3.0-prime'],
  ['openai-video', 'kling-2.5'],
  ['openai-video', 'doubao-seedance-2-5-260628'],
  ['unknown', 'wan-3.0'],
] as const) {
  assert.equal(isVideoAutoModeTarget(type, model), false, `${type}/${model} 不得进入自动模式`);
}

// ── 四行状态表 ──
{
  // 第一行：首图有效、没有尾图 → reference-to-video
  const decision = decideVideoGenerationMode({
    providerType: 'openai-video', model: 'minimax-h3', tailFrameState: 'none',
  });
  assert.deepEqual(decision, { automatic: true, generationMode: 'reference-to-video', blocked: false });
}
{
  // 第三行：首图 + 尾图均有效 → image-to-video
  for (const model of ['minimax-h3', 'wan-3.0']) {
    const decision = decideVideoGenerationMode({
      providerType: 'openai-video', model, tailFrameState: 'ready',
    });
    assert.deepEqual(decision, { automatic: true, generationMode: 'image-to-video', blocked: false }, model);
  }
}
{
  // 第二行：尾图上传中/删除中/失败 → 阻止提交，绝不因为 tailImageId 暂空退回单图
  for (const model of ['minimax-h3', 'wan-3.0']) {
    const decision = decideVideoGenerationMode({
      providerType: 'openai-video', model, tailFrameState: 'pending',
    });
    assert.equal(decision.automatic, true, model);
    assert.equal(decision.blocked, true, `${model} 尾帧操作未完成必须阻止提交`);
  }
}
{
  // 第四行：用户明确移除尾图 → 恢复 reference-to-video
  // 「移除成功」= 状态回到 idle 且没有尾帧 id；「移除中」是 pending（第二行）。
  assert.equal(videoTailFrameDraftState({ tailImageId: null, uploadState: 'idle' }), 'none');
  assert.equal(videoTailFrameDraftState({ tailImageId: null, uploadState: 'deleting' }), 'pending');
  assert.equal(videoTailFrameDraftState({ tailImageId: 'tail', uploadState: 'deleting' }), 'pending');
  assert.equal(videoTailFrameDraftState({ tailImageId: 'tail', uploadState: 'uploading' }), 'pending');
  assert.equal(videoTailFrameDraftState({ tailImageId: null, uploadState: 'failed' }), 'pending');
  assert.equal(videoTailFrameDraftState({ tailImageId: 'tail', uploadState: 'idle' }), 'ready');
  const afterRemoval = decideVideoGenerationMode({
    providerType: 'openai-video', model: 'wan-3.0', tailFrameState: 'none',
  });
  assert.equal(afterRemoval.generationMode, 'reference-to-video', '明确移除尾帧后必须恢复单图参考');
}

// ── 非自动模式模型完全不受影响（可灵 / Seedance / 显式多参考）──
{
  for (const [type, model] of [
    ['openai-video', 'kling-2.5'],
    ['openai-video', 'qiniuyun/kling-3.0'],
    ['jimeng', 'doubao-seedance-2-0-260128'],
    ['openai-video', 'doubao-seedance-2-5-260628'],
  ] as const) {
    const firstTail = decideVideoGenerationMode({
      providerType: type, model, tailFrameState: 'ready', explicitMode: 'image-to-video',
    });
    assert.deepEqual(firstTail, { automatic: false, generationMode: 'image-to-video', blocked: false }, `${type}/${model}`);
    const reference = decideVideoGenerationMode({
      providerType: type, model, tailFrameState: 'none', explicitMode: 'reference-to-video',
    });
    assert.deepEqual(reference, { automatic: false, generationMode: 'reference-to-video', blocked: false }, `${type}/${model}`);
    // 非自动模式不看尾帧草稿状态：显式模式是调用方的合同。
    const pendingButExplicit = decideVideoGenerationMode({
      providerType: type, model, tailFrameState: 'pending', explicitMode: 'image-to-video',
    });
    assert.equal(pendingButExplicit.blocked, false, `${type}/${model} 不得被自动模式规则波及`);
  }
}

// ── 选择函数把尾帧状态喂进决策，并原样暴露两个标记 ──
{
  const providers = [
    {
      id: 'h3', name: '公司 MiniMax H3', type: 'openai-video', defaultModel: 'minimax-h3', configured: true,
      capabilities: {
        durations: [4, 5, 10, 15], tailFrame: { supported: true, protocol: 'company-gateway-tencent-file-infos' },
        multiShot: { supported: false, defaultEnabled: false },
        reference: { supported: true, reason: undefined },
      },
    },
    {
      id: 'k25', name: '公司可灵 2.5', type: 'openai-video', defaultModel: 'kling-2.5', configured: true,
      capabilities: {
        durations: [5, 10], tailFrame: { supported: true, protocol: 'company-gateway-kling' },
        multiShot: { supported: false, defaultEnabled: false },
        reference: { supported: false, reason: 'contract_unverified' },
      },
    },
  ];
  const select = (draft: Record<string, unknown>) => resolveVideoGenerationSelection(providers as never, '', draft as never);
  assert.equal(select({ providerId: 'h3' }).generationMode, 'reference-to-video');
  assert.equal(select({ providerId: 'h3' }).automaticMode, true);
  assert.equal(select({ providerId: 'h3', tailImageId: 'tail' }).generationMode, 'image-to-video');
  assert.equal(select({ providerId: 'k25' }).automaticMode, false);
  assert.equal(select({ providerId: 'k25' }).generationMode, 'image-to-video', '可灵仍按既有显式模式');
}

console.log('video auto mode decision tests passed');
