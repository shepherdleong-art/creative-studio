import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jimengAdapter } from '../lib/video-providers/jimeng.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-adapter-'));
const imagePath = path.join(tmpDir, 'source.png');
const tailImagePath = path.join(tmpDir, 'tail.png');
fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(tailImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

let capturedUrl = '';
let capturedBody: Record<string, unknown> | undefined;
let capturedHeaders: Headers | undefined;
const capturedMethods: string[] = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  capturedUrl = String(input);
  capturedMethods.push(init?.method || 'GET');
  capturedBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
  capturedHeaders = new Headers(init?.headers);
  return new Response(JSON.stringify({
    id: 'task-1',
    model: capturedBody?.model || 'doubao-seedance-1-5-pro-251215',
    status: init?.method === 'POST' ? 'queued' : 'succeeded',
    content: { video_url: 'https://example.com/video.mp4' },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

try {
  assert.deepEqual(jimengAdapter.tailFrameCapability?.('doubao-seedance-2-0-260128'), {
    supported: true,
    protocol: 'ark-content-roles',
  });
  assert.deepEqual(jimengAdapter.tailFrameCapability?.('doubao-seedance-2-5-260628'), {
    supported: true,
    protocol: 'ark-content-roles',
  });
  assert.deepEqual(jimengAdapter.tailFrameCapability?.('doubao-seedance-2-0-260128-fast'), {
    supported: false,
    reason: 'unsupported_model',
  });
  assert.deepEqual(jimengAdapter.tailFrameCapability?.('doubao-seedance-1-5-pro-251215'), {
    supported: false,
    reason: 'unsupported_model',
  });

  const result = await jimengAdapter.submit(
    {
      model: 'doubao-seedance-1-5-pro-251215',
      prompt: '镜头慢慢推进产品细节',
      sourceImagePath: imagePath,
      sourceMimeType: 'image/png',
      durationSec: 5,
    },
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(result.providerTaskId, 'task-1');
  assert.equal(capturedMethods[0], 'POST');
  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
  assert.equal(capturedHeaders?.get('authorization'), 'Bearer ark-key');
  assert.equal(capturedBody?.model, 'doubao-seedance-1-5-pro-251215');
  assert.deepEqual(Object.keys(capturedBody || {}).sort(), [
    'camera_fixed',
    'content',
    'duration',
    'generate_audio',
    'model',
    'ratio',
    'resolution',
    'watermark',
  ]);
  assert.equal(capturedBody?.resolution, '1080p');
  assert.equal(capturedBody?.ratio, 'adaptive');
  assert.equal(capturedBody?.duration, 5);
  assert.equal(capturedBody?.camera_fixed, false);
  assert.equal(capturedBody?.watermark, false);
  assert.equal(capturedBody?.generate_audio, true);

  const content = capturedBody?.content as Array<Record<string, unknown>>;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, '镜头慢慢推进产品细节');
  assert.equal(content[1].type, 'image_url');
  assert.ok((content[1].image_url as { url: string }).url.startsWith('data:image/png;base64,'));
  assert.equal('role' in content[1], false);

  const pollResult = await jimengAdapter.poll(
    'task-1',
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(pollResult.status, 'succeeded');
  assert.equal(pollResult.videoUrl, 'https://example.com/video.mp4');
  assert.equal(capturedMethods[1], 'GET');
  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1');
  assert.equal(capturedHeaders?.get('content-type'), 'application/json');
  assert.equal(capturedHeaders?.get('authorization'), 'Bearer ark-key');

  const tailResult = await jimengAdapter.submit(
    {
      model: 'doubao-seedance-2-0-260128',
      prompt: '从首帧自然过渡到尾帧',
      sourceImagePath: imagePath,
      sourceMimeType: 'image/png',
      tailImagePath,
      tailMimeType: 'image/png',
      durationSec: 5,
    },
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(tailResult.providerTaskId, 'task-1');
  const tailContent = capturedBody?.content as Array<Record<string, unknown>>;
  assert.equal(tailContent.length, 3);
  assert.equal(tailContent[0].type, 'text');
  assert.equal(tailContent[0].text, '从首帧自然过渡到尾帧');
  assert.equal(tailContent[1].type, 'image_url');
  assert.equal((tailContent[1].image_url as { url: string }).url.startsWith('data:image/png;base64,'), true);
  assert.equal(tailContent[1].role, 'first_frame');
  assert.equal(tailContent[2].type, 'image_url');
  assert.equal((tailContent[2].image_url as { url: string }).url.startsWith('data:image/png;base64,'), true);
  assert.equal(tailContent[2].role, 'last_frame');

  await assert.rejects(
    () => jimengAdapter.submit(
      {
        model: 'doubao-seedance-2-0-260128-fast',
        prompt: '不支持的尾帧模型',
        sourceImagePath: imagePath,
        sourceMimeType: 'image/png',
        tailImagePath,
        tailMimeType: 'image/png',
        durationSec: 5,
      },
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
    ),
    /tail frame.*unsupported/i,
  );
  await jimengAdapter.submit({ model: 'doubao-seedance-2-5-260628', prompt: '30 seconds',
    sourceImagePath: imagePath, sourceMimeType: 'image/png', durationSec: 30 },
    'ark-key', 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(capturedBody?.duration, 30);
  assert.equal(jimengAdapter.minimumPollingTimeoutMs?.({ model: 'doubao-seedance-2-5-260628', durationSec: 30 }), 15 * 60_000);
  const beforeInvalid = capturedMethods.length;
  for (const model of ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128']) {
    await assert.rejects(jimengAdapter.submit({ model, prompt: 'invalid 30 seconds',
      sourceImagePath: imagePath, sourceMimeType: 'image/png', durationSec: 30 },
      'ark-key', 'https://ark.cn-beijing.volces.com/api/v3'), /视频时长/);
  }
  assert.equal(capturedMethods.length, beforeInvalid);

  // 多模态参考：三类素材按角色进 content，文本项在最前
  const referenceResult = await jimengAdapter.submitReference?.(
    {
      model: 'doubao-seedance-2-0-260128',
      prompt: '用参考视频的运镜，把参考图里的沙发放进画面',
      references: [
        { kind: 'image', url: 'https://cos.example.com/ref.png?sign=1', mimeType: 'image/png' },
        { kind: 'video', url: 'https://cos.example.com/ref.mp4?sign=2', mimeType: 'video/mp4', durationSec: 4 },
        { kind: 'audio', url: 'https://cos.example.com/ref.mp3?sign=3', mimeType: 'audio/mpeg', durationSec: 3 },
      ],
      durationSec: 8,
      aspectRatio: '9:16',
    },
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(referenceResult?.providerTaskId, 'task-1');
  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
  assert.deepEqual(capturedBody?.content, [
    { type: 'text', text: '用参考视频的运镜，把参考图里的沙发放进画面' },
    { type: 'image_url', image_url: { url: 'https://cos.example.com/ref.png?sign=1' }, role: 'reference_image' },
    { type: 'video_url', video_url: { url: 'https://cos.example.com/ref.mp4?sign=2' }, role: 'reference_video' },
    { type: 'audio_url', audio_url: { url: 'https://cos.example.com/ref.mp3?sign=3' }, role: 'reference_audio' },
  ]);
  assert.equal(capturedBody?.ratio, '9:16');
  assert.equal(capturedBody?.resolution, '1080p');
  assert.equal(capturedBody?.duration, 8);
  assert.equal('camera_fixed' in (capturedBody ?? {}), false, '2.0 系列不发送 camera_fixed');
  assert.equal('omni_reference_task_type' in (capturedBody ?? {}), false, '2.0 不认识 omni_reference_task_type，不得发送');

  // 2.5 参考生成：时长上限 30 秒（20 秒原样透传），显式引导为纯参考子任务
  const reference25Result = await jimengAdapter.submitReference?.(
    {
      model: 'doubao-seedance-2-5-260628',
      prompt: '用参考视频的运镜，把参考图里的沙发放进画面',
      references: [
        { kind: 'image', url: 'https://cos.example.com/ref.png?sign=1', mimeType: 'image/png' },
        { kind: 'video', url: 'https://cos.example.com/ref.mp4?sign=2', mimeType: 'video/mp4', durationSec: 20 },
      ],
      durationSec: 20,
      aspectRatio: '21:9',
    },
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(reference25Result?.providerTaskId, 'task-1');
  assert.equal(capturedBody?.model, 'doubao-seedance-2-5-260628');
  assert.equal(capturedBody?.duration, 20, '2.5 的 20 秒时长原样透传，不被 2.0 的 15 秒钳住');
  assert.equal(capturedBody?.ratio, '21:9');
  assert.equal(capturedBody?.omni_reference_task_type, 'reference', '2.5 全模态参考显式引导为纯参考子任务');
  assert.equal('camera_fixed' in (capturedBody ?? {}), false, '2.5 同属 2.x 家族，不发送 camera_fixed');

  // 2.5 智能编辑：omni=edit、duration=-1 透传不钳制、ratio=adaptive
  const edit25Result = await jimengAdapter.submitReference?.(
    {
      model: 'doubao-seedance-2-5-260628',
      prompt: '把 @视频1 里的沙 发替换成参考图里的款式',
      references: [
        { kind: 'video', url: 'https://cos.example.com/src.mp4?sign=1', mimeType: 'video/mp4', durationSec: 8 },
        { kind: 'image', url: 'https://cos.example.com/sofa.png?sign=2', mimeType: 'image/png' },
      ],
      durationSec: -1,
      aspectRatio: 'adaptive',
      omniReferenceTaskType: 'edit',
    },
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(edit25Result?.providerTaskId, 'task-1');
  assert.equal(capturedBody?.omni_reference_task_type, 'edit', '智能编辑显式引导为 edit 子任务');
  assert.equal(capturedBody?.duration, -1, '编辑子任务锁定时长 -1，原样透传不被钳制');
  assert.equal(capturedBody?.ratio, 'adaptive', '编辑子任务比例锁 adaptive');

  // 2.5 超长视频：omni=extend、duration 显式透传
  const extend25Result = await jimengAdapter.submitReference?.(
    {
      model: 'doubao-seedance-2-5-260628',
      prompt: '向后延长 @视频1，镜头继续向前推进',
      references: [
        { kind: 'video', url: 'https://cos.example.com/src.mp4?sign=1', mimeType: 'video/mp4', durationSec: 6 },
      ],
      durationSec: 12,
      aspectRatio: 'adaptive',
      omniReferenceTaskType: 'extend',
    },
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(extend25Result?.providerTaskId, 'task-1');
  assert.equal(capturedBody?.omni_reference_task_type, 'extend', '超长视频显式引导为 extend 子任务');
  assert.equal(capturedBody?.duration, 12, '延长子任务的显式时长原样透传');
  assert.equal(capturedBody?.ratio, 'adaptive', '延长子任务比例锁 adaptive');

  // 2.0 即使调用方给了 omniReferenceTaskType 也绝不发送（2.0 不认识该字段）
  await jimengAdapter.submitReference?.(
    {
      model: 'doubao-seedance-2-0-260128',
      prompt: '用参考视频的运镜',
      references: [
        { kind: 'video', url: 'https://cos.example.com/ref.mp4?sign=2', mimeType: 'video/mp4', durationSec: 4 },
      ],
      durationSec: 5,
      aspectRatio: '16:9',
      omniReferenceTaskType: 'edit',
    },
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );
  assert.equal('omni_reference_task_type' in (capturedBody ?? {}), false, '2.0 绝不发送 omni_reference_task_type');
  assert.equal(capturedBody?.duration, 5, '2.0 的时长仍按 2.0 上限钳制');
  // 合并回归：所有直连入口保留 -1，非法值在网络请求前拒绝，输出选项不被默认值覆盖。
  for (const model of ['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628']) {
    const imageRequest = { model, prompt: 'auto duration', sourceImagePath: imagePath, sourceMimeType: 'image/png' as const, durationSec: -1, resolution: '720p', generateAudio: false, watermark: true };
    await jimengAdapter.submit(imageRequest, 'ark-key', 'https://ark.example.test');
    assert.equal(capturedBody?.duration, -1);
    assert.equal(capturedBody?.generate_audio, false);
    assert.equal(capturedBody?.watermark, true);
    assert.equal(capturedBody?.resolution, '720p');
    await jimengAdapter.submitText?.(imageRequest, 'ark-key', 'https://ark.example.test');
    assert.equal(capturedBody?.duration, -1);
    await jimengAdapter.submitReference?.({ ...imageRequest, references: [] }, 'ark-key', 'https://ark.example.test');
    assert.equal(capturedBody?.duration, -1);
    for (const durationSec of [0, -2, 3, 4.5, NaN, Infinity, model.includes('2-5') ? 31 : 16]) {
      const before = capturedMethods.length;
      await assert.rejects(jimengAdapter.submit({ ...imageRequest, durationSec }, 'ark-key', 'https://ark.example.test'), /视频时长/);
      await assert.rejects(jimengAdapter.submitText!({ ...imageRequest, durationSec }, 'ark-key', 'https://ark.example.test'), /视频时长/);
      await assert.rejects(jimengAdapter.submitReference!({ ...imageRequest, durationSec, references: [] }, 'ark-key', 'https://ark.example.test'), /视频时长/);
      assert.equal(capturedMethods.length, before);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('jimeng video adapter tests passed');
