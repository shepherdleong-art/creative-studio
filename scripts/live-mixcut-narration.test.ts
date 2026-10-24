import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-narration-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example/v1';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'alignment-test-key';
process.env.FINAL_EDIT_ALIGNMENT_MODEL = 'words-test';
const originalFetch = globalThis.fetch;
const db = new Database(':memory:');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project-a'),('project-b');
  CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,type TEXT,baseUrl TEXT,apiKey TEXT,keyEnv TEXT,model TEXT,enabled INTEGER);
  INSERT INTO final_edit_tts_providers VALUES ('vapi-qwen3-tts','测试音色','vapi-qwen-json-url','https://voice.example','test-secret',NULL,'qwen3-tts-flash',1);`);

// 外部服务返回有声音的 PCM；实际标准化、文件时长和缓存均由生产代码处理。
function toneWav(): Buffer {
  const rate = 16_000, bytes = rate * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF'); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < rate; i++) wav.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return wav;
}
const spoken: string[] = [];
let alignedText = '坐得稳';
let silent = false;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/audio/speech')) {
    spoken.push(JSON.parse(String(init?.body)).input);
    const audio = toneWav();
    if (silent) audio.fill(0, 44);
    return Response.json({ output: { audio: { data: audio.toString('base64') } } });
  }
  if (String(url).startsWith('https://alignment.example/')) return Response.json({
    words: [{ word: alignedText, start: 0.1, end: 0.9 }],
  });
  throw new Error('禁止测试访问其他网络地址');
};

try {
  const { captureFormulaTtsService, synthesizeFormulaNarration } = await import('../lib/live-mixcut/formula/narration.ts');
  const service = captureFormulaTtsService(db, { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 });
  const result = await synthesizeFormulaNarration(db, 'project-a', { text: '坐得稳。', service }, new AbortController().signal);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('实际声音未就绪');
  assert.deepEqual(spoken, ['坐得稳。'], '只能发送当前剩余文案');
  assert.equal(result.audio.durationUs, 1_000_000, '时长应来自实际一秒音频');
  assert.deepEqual(result.audio.words, [{ text: '坐得稳', startUs: 100_000, endUs: 900_000 }]);
  assert.equal(result.executionReady, false, '单块声音不能冒充完整成片');
  assert.equal(fs.existsSync(path.join(root, 'storage', result.audio.relativePath)), true);
  assert.equal(JSON.stringify(service).includes('test-secret'), false);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  const repeated = await synthesizeFormulaNarration(db, 'project-a', { text: '坐得稳。', service }, new AbortController().signal);
  assert.equal(repeated.status, 'ready');
  if (repeated.status !== 'ready') throw new Error('复用声音未就绪');
  assert.equal(repeated.audio.relativePath, result.audio.relativePath, '相同项目、确切文案和声音参数应复用实际音频');
  assert.deepEqual(spoken, ['坐得稳。'], '再次制作同样文案不应再次请求付费配音');
  alignedText = '同字数';
  const failedAlignment = await synthesizeFormulaNarration(db, 'project-b', { text: '坐得稳。', service }, new AbortController().signal);
  assert.equal(failedAlignment.status, 'needs_alignment', '不能把等分字幕或同字数的错误台词当作已对齐');
  if (failedAlignment.status !== 'needs_alignment') throw new Error('应保留真实声音并等待对齐');
  assert.deepEqual(failedAlignment.audio.words, []);
  alignedText = '坐得稳';
  const repaired = await synthesizeFormulaNarration(db, 'project-b', { text: '坐得稳。', service }, new AbortController().signal);
  assert.equal(repaired.status, 'ready');
  if (repaired.status !== 'ready') throw new Error('重试对齐失败');
  assert.equal(repaired.audio.relativePath, failedAlignment.audio.relativePath, '对齐失败后重试应保留已生成声音');
  assert.equal(spoken.length, 2, '另一个项目单独生成；其对齐重试不能重复生成声音');
  silent = true;
  alignedText = '不能用静音';
  await assert.rejects(synthesizeFormulaNarration(db, 'project-a', { text: '不能用静音。', service }, new AbortController().signal), /配音处理失败/);
  silent = false;
  alignedText = '坐得稳';
  const beforeConfigCheck = spoken.length;
  db.exec("UPDATE final_edit_tts_providers SET model='another-model'");
  await assert.rejects(synthesizeFormulaNarration(db, 'project-a', { text: '坐得稳。', service }, new AbortController().signal), /配置已变化/);
  assert.equal(spoken.length, beforeConfigCheck);
  db.exec("UPDATE final_edit_tts_providers SET model='qwen3-tts-flash',apiKey='rotated-key'");
  assert.equal((await synthesizeFormulaNarration(db, 'project-a', { text: '坐得稳。', service }, new AbortController().signal)).status, 'ready');
  assert.equal(spoken.length, beforeConfigCheck, '只更新密钥可复用相同声音');
  fs.writeFileSync(path.join(root, 'storage', result.audio.relativePath), Buffer.alloc(128));
  const regenerated = await synthesizeFormulaNarration(db, 'project-a', { text: '坐得稳。', service }, new AbortController().signal);
  assert.equal(regenerated.status, 'ready', '缓存文件坏了必须重建，不能仅凭缓存记录通过');
  assert.equal(spoken.length, beforeConfigCheck + 1);
  const noVoice = await synthesizeFormulaNarration(db, 'project-a', { text: '坐得稳。', service: null }, new AbortController().signal);
  assert.equal(noVoice.status, 'needs_attention');
  assert.equal(spoken.length, beforeConfigCheck + 1, '没选音色不能默认调用某个服务');
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(synthesizeFormulaNarration(db, 'project-a', { text: '坐得稳。', service }, stopped.signal), { name: 'AbortError' });
  await assert.rejects(synthesizeFormulaNarration(db, 'unknown', { text: '坐得稳。', service }, new AbortController().signal), /不存在/);
  // 精确输入缓存不把文字标点或音色变化当成相同付费请求。
  await synthesizeFormulaNarration(db, 'project-a', { text: '坐得稳！', service }, new AbortController().signal);
  const otherVoice = captureFormulaTtsService(db, { providerId: 'vapi-qwen3-tts', voice: 'Ethan', speed: 1 });
  await synthesizeFormulaNarration(db, 'project-a', { text: '坐得稳。', service: otherVoice }, new AbortController().signal);
  assert.equal(spoken.length, beforeConfigCheck + 3);
  globalThis.fetch = async () => new Response('test-secret upstream private diagnostic', { status: 400 });
  await assert.rejects(synthesizeFormulaNarration(db, 'project-a', { text: '另一个请求', service }, new AbortController().signal),
    error => error instanceof Error && error.message === '配音处理失败，请检查服务后重试');
  const cancelledDuringRequest = new AbortController();
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    cancelledDuringRequest.abort();
  });
  await assert.rejects(synthesizeFormulaNarration(db, 'project-a', { text: '取消网络。', service }, cancelledDuringRequest.signal), { name: 'AbortError' });
  console.log('formula narration tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('formula-narration-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
