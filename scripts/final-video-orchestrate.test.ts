import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { ClipPoolItem, NarrationBeat } from '../lib/final-video/types.ts';

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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-orchestrate-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const { getDb } = await import('../lib/db.ts');
const { buildArrangement } = await import('../lib/final-video/orchestrate.ts');
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

const beat = (beatId: string, index: number, durationSec: number): NarrationBeat => ({
  beatId, groupId: `group-${beatId}`, index, text: `narration ${beatId}`,
  audioPath: `/private/narration/${beatId}.mp3`, durationSec, startSec: index,
});
const clip = (clipId: string, shotIndex: number, visualDescription: string): ClipPoolItem => ({
  clipId, shotId: `shot-${clipId}`, shotIndex, videoPath: `/private/video/${clipId}.mp4`, clipDurationSec: 10,
  sourceImageId: `image-${clipId}`, sourceImagePath: `/private/image/${clipId}.png`, visualDescription,
  descriptionProviderId: visualDescription.trim() ? 'vision' : null, descriptionModel: visualDescription.trim() ? 'vision-model' : null,
});
const beats = [beat('b0', 0, 1), beat('b1', 1, 2), beat('b2', 2, 1)];
const clips = [clip('c0', 0, 'red product on a table'), clip('c1', 1, 'close-up of the product'), clip('c2', 2, '  ')];

function configure(): void {
  db.prepare(`UPDATE script_providers SET baseUrl = ?, apiKey = ?, model = ?, apiStyle = ?, enabled = 1 WHERE id = 'qwen'`)
    .run('https://qwen.example/api', 'qwen-secret', 'qwen-model', 'openai-compatible');
}

function responseWithPlan(plan: unknown): void {
  response = { ok: true, status: 200, json: { choices: [{ message: { content: typeof plan === 'string' ? plan : JSON.stringify(plan) } }] } };
}

function assertFallback(result: Awaited<ReturnType<typeof buildArrangement>>): void {
  assert.equal(result.issues.at(-1)?.code, 'arrangement_fallback_used');
  assert.equal(result.issues.at(-1)?.severity, 'warning');
  assert.deepEqual(result.plan, {
    assignments: [
      { assignmentId: 'fallback-0', clipId: 'c0', beatIds: ['b0', 'b1'] },
      { assignmentId: 'fallback-1', clipId: 'c1', beatIds: ['b2'] },
    ],
    gaps: [],
  });
}

try {
  configure();

  responseWithPlan({
    assignments: [{ clipId: 'c0', beatIds: ['b0', 'b1'], ignored: true }],
    gaps: [{ beatId: 'b2', reason: ' No matching visual ', ignored: true }], ignored: true,
  });
  fetchCalls = [];
  const legal = await buildArrangement({ beats, clips, maxClipSeconds: 3, providerId: 'qwen' });
  assert.deepEqual(legal, {
    plan: {
      assignments: [{ assignmentId: 'llm-0', clipId: 'c0', beatIds: ['b0', 'b1'] }],
      gaps: [{ beatId: 'b2', reason: 'No matching visual' }],
    },
    issues: [],
  });
  assert.equal(fetchCalls.length, 1);
  const userPrompt = (fetchCalls[0].body.messages as Array<{ role: string; content: string }>).at(-1)?.content ?? '';
  assert.match(userPrompt, /b0/);
  assert.match(userPrompt, /narration b1/);
  assert.match(userPrompt, /red product on a table/);
  assert.doesNotMatch(userPrompt, /\/private\//);
  assert.doesNotMatch(userPrompt, /c2/);

  responseWithPlan('```json\n{"assignments":[{"clipId":"c0","beatIds":["b0","b1"]}],"gaps":[{"beatId":"b2","reason":"fenced"}]}\n```');
  const fenced = await buildArrangement({ beats, clips, maxClipSeconds: 3, providerId: 'qwen' });
  assert.equal(fenced.issues.length, 0);
  assert.deepEqual(fenced.plan.assignments[0], { assignmentId: 'llm-0', clipId: 'c0', beatIds: ['b0', 'b1'] });

  responseWithPlan({
    assignments: [{ clipId: 'c2', beatIds: ['b0', 'b1'] }],
    gaps: [{ beatId: 'b2', reason: 'unseen clip' }],
  });
  assertFallback(await buildArrangement({ beats, clips, maxClipSeconds: 3, providerId: 'qwen' }));

  for (const invalid of [
    { assignments: [{ clipId: 'missing', beatIds: ['b0'] }], gaps: [{ beatId: 'b1', reason: 'x' }, { beatId: 'b2', reason: 'x' }] },
    { assignments: [{ clipId: 'c0', beatIds: ['b0'] }, { clipId: 'c0', beatIds: ['b1'] }], gaps: [{ beatId: 'b2', reason: 'x' }] },
    { assignments: [{ clipId: 'c0', beatIds: ['b1'] }, { clipId: 'c1', beatIds: ['b0'] }], gaps: [{ beatId: 'b2', reason: 'x' }] },
    { assignments: [{ clipId: 'c0', beatIds: ['b0'] }], gaps: [] },
  ]) {
    responseWithPlan(invalid);
    assertFallback(await buildArrangement({ beats, clips, maxClipSeconds: 3, providerId: 'qwen' }));
  }

  response = { ok: false, status: 502, text: 'provider failed' };
  assertFallback(await buildArrangement({ beats, clips, maxClipSeconds: 3, providerId: 'qwen' }));

  responseWithPlan({ assignments: [], gaps: beats.map(({ beatId }) => ({ beatId, reason: 'unused' })) });
  fetchCalls = [];
  assertFallback(await buildArrangement({ beats, clips: clips.map((item) => ({ ...item, visualDescription: ' ' })), maxClipSeconds: 3, providerId: 'qwen' }));
  assert.equal(fetchCalls.length, 0, 'all undescribed clips must bypass the provider');

  console.log('final-video-orchestrate tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
