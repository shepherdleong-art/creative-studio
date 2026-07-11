import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';

const projectRootUrl = new URL('../', import.meta.url);
type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => unknown;
const registerHooks = (nodeModule as unknown as {
  registerHooks(hooks: { resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown }): void;
}).registerHooks;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const candidate = new URL(`${specifier.slice(2)}.ts`, projectRootUrl);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-narration-script-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const { generateNarrationDraftBeats } = await import('../lib/final-video/narration-script.ts');
const { getDb } = await import('../lib/db.ts');
const { defaultScriptProviderConfigs } = await import('../lib/script-providers/config.ts');
const db = getDb();
const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let response: { ok: boolean; status: number; json?: unknown; text?: string };

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
  return {
    ok: response.ok,
    status: response.status,
    json: async () => response.json,
    text: async () => response.text || '',
  } as Response;
}) as typeof fetch;

function configure(id: 'qwen' | 'gemini', apiStyle: 'native-gemini' | 'openai-compatible', enabled = 1): void {
  db.prepare(`UPDATE script_providers SET baseUrl = ?, apiKey = ?, model = ?, apiStyle = ?, enabled = ? WHERE id = ?`)
    .run(`https://${id}.example/api`, `${id}-secret`, `${id}-model`, apiStyle, enabled, id);
}

async function rejectsFor(payload: unknown, pattern: RegExp): Promise<void> {
  response = { ok: true, status: 200, json: { choices: [{ message: { content: payload } }] } };
  await assert.rejects(
    generateNarrationDraftBeats({ sourceText: 'source', targetContentSec: 12, providerId: 'qwen' }),
    pattern,
  );
}

try {
  configure('qwen', 'openai-compatible');

  for (const invalid of [
    { sourceText: '   ', targetContentSec: 12 },
    { sourceText: 'source', targetContentSec: 0 },
    { sourceText: 'source', targetContentSec: Number.NaN },
  ]) {
    fetchCalls = [];
    await assert.rejects(generateNarrationDraftBeats({ ...invalid, providerId: 'qwen' }), /sourceText|targetContentSec/);
    assert.equal(fetchCalls.length, 0, 'invalid input must not call provider');
  }

  const longSentence = '  这是一句很长、但仍应保持完整的自然句。  ';
  response = { ok: true, status: 200, json: { choices: [{ message: { content: JSON.stringify({
    sentences: [
      { text: '  第一句，保留  内部空格。 ', id: 'model-id', index: 99 },
      { text: longSentence },
      { text: '   ' },
    ],
    extra: true,
  }) } }] } };
  fetchCalls = [];
  const beats = await generateNarrationDraftBeats({ sourceText: ' 原始商品文案 ', targetContentSec: 13.5, providerId: 'qwen' });
  assert.deepEqual(beats, [
    { beatId: 'narration-0', groupId: 'narration-0', index: 0, text: '第一句，保留  内部空格。' },
    { beatId: 'narration-1', groupId: 'narration-1', index: 1, text: '这是一句很长、但仍应保持完整的自然句。' },
  ]);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /qwen\.example\/api\/v1\/chat\/completions$/);
  assert.equal(fetchCalls[0].body.temperature, 0.4);
  assert.deepEqual(fetchCalls[0].body.response_format, { type: 'json_object' });
  const messages = fetchCalls[0].body.messages as Array<{ role: string; content: string }>;
  assert.match(messages[0].content, /valid JSON only/i);
  assert.match(messages[1].content, /13\.5/);
  assert.match(messages[1].content, /不要.*镜头|not.*shots/i);
  assert.match(messages[1].content, /原始商品文案/);
  assert.match(messages[1].content, /"sentences"/);

  response = { ok: true, status: 200, json: { choices: [{ message: { content: '```json\n{"sentences":[{"text":"围栏也能解析。"}]}\n```' } }] } };
  assert.equal((await generateNarrationDraftBeats({ sourceText: 'source', targetContentSec: 5, providerId: 'qwen' }))[0].text, '围栏也能解析。');

  response = { ok: true, status: 200, json: { choices: [{ message: { content: '   ' } }] } };
  await assert.rejects(generateNarrationDraftBeats({ sourceText: 'source', targetContentSec: 5, providerId: 'qwen' }), /空响应/);
  await rejectsFor('{bad json', /无效 JSON/);
  for (const value of [null, [], {}, { sentences: 'wrong' }, { sentences: [] }, { sentences: [{ text: 1 }] }, { sentences: [{ text: '  ' }] }]) {
    await rejectsFor(JSON.stringify(value), /sentences|自然句/);
  }

  response = { ok: false, status: 429, text: 'rate limited' };
  await assert.rejects(generateNarrationDraftBeats({ sourceText: 'source', targetContentSec: 5, providerId: 'qwen' }), /429.*rate limited/);

  await assert.rejects(generateNarrationDraftBeats({ sourceText: 'source', targetContentSec: 5, providerId: 'missing' }), /未知的脚本模型/);
  configure('qwen', 'openai-compatible', 0);
  await assert.rejects(generateNarrationDraftBeats({ sourceText: 'source', targetContentSec: 5, providerId: 'qwen' }), /未配置完整/);

  const geminiDefaults = defaultScriptProviderConfigs.find((item) => item.id === 'gemini');
  assert.ok(geminiDefaults);
  geminiDefaults.apiStyle = 'native-gemini';
  configure('gemini', 'native-gemini');
  response = { ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: '{"sentences":[{"text":"原生成功。"}]}' }] } }] } };
  fetchCalls = [];
  const native = await generateNarrationDraftBeats({ sourceText: 'native source', targetContentSec: 8, providerId: 'gemini' });
  assert.equal(native[0].text, '原生成功。');
  assert.match(fetchCalls[0].url, /gemini\.example\/api\/v1beta\/models\/gemini-model:generateContent\?key=gemini-secret$/);
  assert.equal((fetchCalls[0].body.generationConfig as Record<string, unknown>).temperature, 0.4);
  const nativePrompt = (((fetchCalls[0].body.contents as Array<{ parts: Array<{ text: string }> }>)[0].parts)[0].text);
  assert.match(nativePrompt, /native source/);

  console.log('final-video-narration-script tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
