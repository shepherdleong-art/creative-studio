import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScriptProviderRuntimeConfig } from '../lib/script-providers/config.ts';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-usage-llm-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
const originalFetch = globalThis.fetch;

type UsageAwareChatOptions = {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
  timeoutMs?: number;
  signal?: AbortSignal;
  images?: Array<{ mimeType: string; imageBase64?: string; imageUrl?: string }>;
  usageContext?: { enabled: true };
};

let closeDb: (() => void) | undefined;

try {
  const { getDb, closeDb: importedCloseDb } = await import('../lib/db.ts');
  closeDb = importedCloseDb;
  const { chatCompletion, completeOpenAiCompatibleJson } = await import('../lib/script-providers/openai-compatible.ts');
  const { recoverInterruptedUsageCalls, drainBillableUsageCalls } = await import('../lib/usage-ledger.ts');
  const db = getDb();

  const config = {
    id: 'gpt',
    name: '公司 GPT',
    apiStyle: 'openai-compatible' as const,
    keyEnv: '',
    baseUrlEnv: '',
    modelEnv: '',
    defaultModel: 'GPT-5-6-Luna-Standard',
    defaultBaseUrl: 'http://127.0.0.1:4000',
    maxTokens: 16_384,
  };
  const runtime: ScriptProviderRuntimeConfig = {
    id: 'gpt',
    name: '公司 GPT',
    apiStyle: 'openai-compatible' as const,
    baseUrl: 'http://127.0.0.1:4000',
    apiKey: 'local-key',
    model: 'GPT-5-6-Luna-Standard',
    maxTokens: 16_384,
    enabled: true,
    configured: true,
    missing: [],
    hasApiKey: true,
    supportsVision: true,
    visionCostPerRequest: 0,
    executionScope: 'company' as const,
  };

  const tracked = (options: Omit<UsageAwareChatOptions, 'usageContext'>, provider = runtime) =>
    chatCompletion(config, { ...options, usageContext: { enabled: true } } as never, provider);

  const clearUsage = () => {
    db.exec('DELETE FROM usage_ledger; DELETE FROM usage_call_events;');
  };

  const source = fs.readFileSync(path.join(process.cwd(), 'lib/script-providers/index.ts'), 'utf8');
  assert.match(source, /usageContext/, 'completeJson 必须显式接入 LLM usage context');
  assert.match(source, /usageContext:\s*\{\s*enabled:\s*true\s*\}/, 'completeJson 必须启用 usage 记账');
  assert.match(
    source,
    /export async function analyzeSellingPoints[\s\S]*?usageContext:\s*\{\s*enabled:\s*true\s*\}/,
    'analyzeSellingPoints 的 OpenAI-compatible 路径也必须启用 usage 记账',
  );

  // Exact company GPT text calls use the fixed plan, cache split, and llm_text category.
  clearUsage();
  let requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return Response.json({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
  };
  assert.equal(await tracked({ systemPrompt: 'system', userPrompt: 'user', responseFormat: 'json_object' }), '{"ok":true}');
  assert.equal(requestBodies.length, 1);
  const exactLedger = db.prepare('SELECT * FROM usage_ledger').get() as Record<string, unknown>;
  assert.equal(exactLedger.category, 'llm_text');
  assert.equal(exactLedger.model, 'GPT-5-6-Luna-Standard');
  assert.equal(exactLedger.quantity, 17);
  assert.equal(exactLedger.callCount, 1);
  assert.equal(exactLedger.projectId, '');
  assert.equal(exactLedger.refType, 'llm_call');
  assert.match(String(exactLedger.refId), /^[0-9a-f-]{36}$/);
  const exactDetail = JSON.parse(String(exactLedger.detailJson)) as Record<string, unknown>;
  assert.equal(exactDetail.estimated, false);
  assert.equal(exactDetail.promptTokens, 10);
  assert.equal(exactDetail.completionTokens, 7);
  assert.equal(exactDetail.cachedReadTokens, 3);
  assert.equal(exactDetail.uncachedInputTokens, 7);
  assert.equal(exactDetail.outputTokens, 7);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_call_events').get() as { count: number }).count, 1);
  assert.equal(drainBillableUsageCalls(db).recorded, 0, '重复 drain 不得重复记账');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get() as { count: number }).count, 1);

  // Image input changes only the accounting category, not the fixed identity gate.
  clearUsage();
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: {
      input_tokens: 8,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 5 },
    },
  });
  await tracked({
    systemPrompt: 'system',
    userPrompt: 'image',
    images: [{ mimeType: 'image/jpeg', imageBase64: 'abc' }],
  });
  assert.equal((db.prepare('SELECT category FROM usage_ledger').get() as { category: string }).category, 'llm_vision');

  // Same model with an external scope or a different provider ID is not tracked.
  clearUsage();
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  await tracked({ systemPrompt: 'system', userPrompt: 'external' }, { ...runtime, executionScope: 'external' });
  await tracked({ systemPrompt: 'system', userPrompt: 'other provider' }, { ...runtime, id: 'qwen', name: '通义千问' });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get() as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_call_events').get() as { count: number }).count, 0);

  // Temperature fallback is two real HTTP calls, each with an independent event key;
  // only the successful second response becomes billable.
  clearUsage();
  let fallbackRequests = 0;
  globalThis.fetch = async () => {
    fallbackRequests += 1;
    if (fallbackRequests === 1) {
      return new Response('Unsupported value: temperature is not supported', { status: 400 });
    }
    return Response.json({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    });
  };
  await tracked({ systemPrompt: 'system', userPrompt: 'fallback', temperature: 0.2 });
  const fallbackEvents = db.prepare('SELECT eventKey, status FROM usage_call_events ORDER BY createdAt, eventKey').all() as Array<{ eventKey: string; status: string }>;
  assert.equal(fallbackRequests, 2);
  assert.equal(fallbackEvents.length, 2);
  assert.notEqual(fallbackEvents[0].eventKey, fallbackEvents[1].eventKey);
  assert.deepEqual(new Set(fallbackEvents.map((event) => event.status)), new Set(['started', 'recorded']));
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get() as { count: number }).count, 1);
  const recovered = recoverInterruptedUsageCalls(db, 'different-owner');
  assert.equal(recovered.uncertain, 1, '失败请求保留 started，恢复时才转 uncertain');
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM usage_call_events WHERE status='uncertain'").get() as { count: number }).count, 1);

  // A successful response without usable usage is charged from Unicode character lengths,
  // before JSON parsing; malformed business JSON still leaves a ledger row.
  clearUsage();
  requestBodies = [];
  const invalidJsonOutput = '不是 JSON🙂';
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return Response.json({ choices: [{ message: { content: invalidJsonOutput } }] });
  };
  await assert.rejects(
    completeOpenAiCompatibleJson(config, {
      systemPrompt: '系统🙂',
      userPrompt: '用户文本',
      responseFormat: undefined,
      usageContext: { enabled: true },
    } as never, runtime),
    /无效 JSON/,
  );
  const estimatedLedger = db.prepare('SELECT * FROM usage_ledger').get() as Record<string, unknown>;
  const estimatedDetail = JSON.parse(String(estimatedLedger.detailJson)) as Record<string, unknown>;
  const serializedPrompt = JSON.stringify(requestBodies[0].messages);
  assert.equal(estimatedDetail.estimated, true);
  assert.equal(estimatedDetail.promptTokens, Array.from(serializedPrompt).length);
  assert.equal(estimatedDetail.completionTokens, Array.from(invalidJsonOutput).length);
  assert.equal(estimatedDetail.cachedReadTokens, 0);
  assert.equal(estimatedDetail.uncachedInputTokens, Array.from(serializedPrompt).length);
  assert.equal(estimatedDetail.outputTokens, Array.from(invalidJsonOutput).length);
  assert.equal(estimatedLedger.quantity, Array.from(serializedPrompt).length + Array.from(invalidJsonOutput).length);

  // A successful HTTP response whose transport body is not JSON must still
  // leave an estimated usage row before the adapter reports the malformed body.
  clearUsage();
  const malformedTransportBody = '{"choices":';
  globalThis.fetch = async () => new Response(malformedTransportBody, { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    tracked({ systemPrompt: 'system', userPrompt: 'malformed HTTP JSON' }),
    /无效响应 JSON/,
  );
  const malformedHttpLedger = db.prepare('SELECT * FROM usage_ledger').get() as Record<string, unknown>;
  assert.equal(typeof malformedHttpLedger?.eventKey, 'string');
  const malformedHttpDetail = JSON.parse(String(malformedHttpLedger.detailJson)) as Record<string, unknown>;
  assert.equal(malformedHttpDetail.estimated, true);
  assert.equal(malformedHttpDetail.outputTokens, Array.from(malformedTransportBody).length);

  clearUsage();
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: { prompt_tokens: 'not-a-number', completion_tokens: 2 },
  });
  await completeOpenAiCompatibleJson(config, {
    systemPrompt: 'system',
    userPrompt: 'malformed usage',
    usageContext: { enabled: true },
  } as never, runtime);
  const malformedDetail = JSON.parse(String((db.prepare('SELECT detailJson FROM usage_ledger').get() as { detailJson: string }).detailJson)) as Record<string, unknown>;
  assert.equal(malformedDetail.estimated, true, '畸形 usage 也必须走字符估算');

  // Ledger failure must never replace a successful model result.
  const brokenDb = getDb();
  globalThis.fetch = async () => {
    brokenDb.close();
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };
  assert.equal(await tracked({ systemPrompt: 'system', userPrompt: 'ledger failure' }), '{"ok":true}');
} finally {
  try { closeDb?.(); } catch { /* test deliberately closes the shared DB in the final case */ }
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows may hold WAL briefly */ }
  globalThis.fetch = originalFetch;
}

console.log('usage llm tests passed');
