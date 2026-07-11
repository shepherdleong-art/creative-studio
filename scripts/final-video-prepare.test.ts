import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';

const projectRootUrl = new URL('../', import.meta.url);
type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => unknown;
const registerHooks = (nodeModule as unknown as { registerHooks(hooks: {
  resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown;
}): void }).registerHooks;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-prepare-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const prepareRoute = await import('../app/api/final-video-drafts/[id]/prepare/route.ts');
const { getDb } = await import('../lib/db.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const { defaultPackageConfig } = await import('../lib/final-video/types.ts');
const { createFinalVideoDraft, getFinalVideoDraft } = await import('../lib/final-video/draft-store.ts');

const db = getDb();

try {
  // ── Fixtures: providers, project, shot set, script drafts ──
  db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl, model) VALUES ('provider', 'Provider', '', 'model')`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-1', 'Project', 'provider', 'model', '')`).run();
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('shot-set-1', 'project-1', 'One')`).run();
  db.prepare(`
    INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel)
    VALUES ('video-provider', 'Video', 'kling', '', '', '', 'model')
  `).run();

  db.prepare(`UPDATE script_providers SET baseUrl = ?, apiKey = ?, model = ?, apiStyle = ?, enabled = 1 WHERE id = 'qwen'`)
    .run('https://qwen.example/api', 'qwen-secret', 'qwen-model', 'openai-compatible');
  db.prepare(`UPDATE narration_providers SET apiKey = ?, baseUrl = ?, model = ?, voices = ?, enabled = 1 WHERE id = 'openai-tts'`)
    .run('tts-secret', 'https://tts.example', 'tts-model', 'test-voice');

  function scriptDraft(id: string, outputJson: unknown): void {
    const raw = typeof outputJson === 'string' ? outputJson : JSON.stringify(outputJson);
    db.prepare(`INSERT INTO script_drafts (id, projectId, model, inputSnapshot, outputJson) VALUES (?, 'project-1', 'model', '{}', ?)`)
      .run(id, raw);
  }
  scriptDraft('script-full', { fullScript: '这是完整口播文案，用于验证优先读取全文。', shots: [] });
  scriptDraft('script-fallback', { fullScript: '', shots: [{ voiceover: '第一句分镜台词。' }, { voiceover: '第二句分镜台词。' }] });
  scriptDraft('script-empty', { fullScript: '', shots: [{ voiceover: '' }, {}] });
  scriptDraft('script-broken', '{not valid json');

  // ── Fixtures: one shot with a succeeded video job so the clip pool is non-empty ──
  const storage = path.join(testRoot, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  const media = path.join(storage, 'clip.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=25:d=1.5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media]);
  const imagePath = path.join(storage, 'image-1.png');
  fs.writeFileSync(imagePath, 'image fixture');
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path) VALUES ('image-1', 'project-1', 'output', 'image-1.png', ?)`).run(imagePath);
  db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, latestGeneratedImageId) VALUES ('shot-1', 'shot-set-1', 0, 'image-1', 'image-1')`).run();
  db.prepare(`
    INSERT INTO video_jobs (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, prompt, durationSec, status, localVideoPath, createdAt, finishedAt)
    VALUES ('video-job-1', 'project-1', 'shot-set-1', 'shot-1', 'image-1', 'video-provider', 'model', '', 5, 'succeeded', ?, '2026-01-01 00:00:00', '2026-01-01 00:01:00')
  `).run(media);

  // ── Fixtures: TTS source audio (real, via lavfi) reused for every synthesized sentence ──
  const ttsSourceWav = path.join(testRoot, 'tts-source.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5', '-c:a', 'pcm_s16le', '-y', ttsSourceWav]);
  const ttsSourceBytes = fs.readFileSync(ttsSourceWav);

  // ── fetch mock: dispatch by URL between the narration-script LLM call and the TTS call ──
  const originalFetch = globalThis.fetch;
  let narrationCalls = 0;
  let ttsCalls = 0;
  const narrationRequests: Array<Record<string, unknown>> = [];
  const ttsRequests: Array<Record<string, unknown>> = [];
  let ttsFailureMode: 'none' | 'http-error' = 'none';
  const SENTENCES = ['这是第一句测试口播文本，用于验证流程。', '这是第二句测试口播文本，同样验证流程。'];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/chat/completions')) {
      narrationCalls += 1;
      narrationRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ sentences: SENTENCES.map((text) => ({ text })) }) } }] });
    }
    if (url.includes('/audio/speech')) {
      ttsCalls += 1;
      ttsRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (ttsFailureMode === 'http-error') return new Response('server error', { status: 500 });
      return new Response(ttsSourceBytes, { status: 200, headers: { 'content-type': 'audio/wav' } });
    }
    throw new Error(`unexpected fetch url in test: ${url}`);
  }) as typeof fetch;

  // ── helpers ──
  function bgmWorkflowConfig() {
    return {
      packageConfig: { ...defaultPackageConfig(), outputName: 'bgm-test' },
      narrationScriptProviderId: 'qwen',
      visionProviderId: 'vision-provider',
      orchestrationProviderId: 'orchestration-provider',
      selectedClipIds: [],
    };
  }
  function narrationWorkflowConfig(overrides: { targetDurationSec?: number; introDurationSec?: number } = {}) {
    const base = defaultPackageConfig();
    return {
      packageConfig: {
        ...base,
        mode: 'narration' as const,
        outputName: 'narration-test',
        targetDurationSec: overrides.targetDurationSec ?? base.targetDurationSec,
        cover: { ...base.cover, introDurationSec: overrides.introDurationSec ?? base.cover.introDurationSec },
        narration: { mode: 'tts' as const, providerId: 'openai-tts', voice: 'test-voice', speed: 1.15 },
      },
      narrationScriptProviderId: 'qwen',
      visionProviderId: 'vision-provider',
      orchestrationProviderId: 'orchestration-provider',
      selectedClipIds: [],
    };
  }
  function jsonRequest(body: unknown): Request {
    return new Request('http://test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  function ctx(id: string) { return { params: Promise.resolve({ id }) }; }
  async function responseFor(pending: Promise<Response>) {
    const response = await pending;
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  async function prepare(id: string, revision: number) {
    return responseFor(prepareRoute.POST(jsonRequest({ revision }), ctx(id)));
  }

  // ── bgm-only happy path: never touches narration/TTS, ends in review ──
  const bgmDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: bgmWorkflowConfig() });
  assert.equal(bgmDraft.stage, 'draft');
  const bgmResult = await prepare(bgmDraft.id, 0);
  assert.equal(bgmResult.status, 200);
  const bgmBody = bgmResult.body.draft as Record<string, unknown>;
  assert.equal(bgmBody.stage, 'review');
  assert.equal(bgmBody.revision, 2, 'preparing bump + final patch = +2 revisions');
  assert.deepEqual(bgmBody.narrationBeats, []);
  assert.equal((bgmBody.clipPool as unknown[]).length, 1);
  assert.equal((bgmBody.clipPool as Array<Record<string, unknown>>)[0].clipId, 'video-job-1');
  assert.deepEqual(bgmBody.issues, []);
  assert.equal(narrationCalls, 0, 'bgm-only must never call the narration-script LLM');
  assert.equal(ttsCalls, 0, 'bgm-only must never call TTS');

  // ── bgm-only with a scriptDraftId pointing at genuinely broken JSON: must still never read it ──
  const bgmBrokenDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-broken', workflowConfig: bgmWorkflowConfig() });
  const bgmBrokenResult = await prepare(bgmBrokenDraft.id, 0);
  assert.equal(bgmBrokenResult.status, 200, 'bgm-only must never parse the script draft, even if it is malformed JSON');
  assert.equal((bgmBrokenResult.body.draft as Record<string, unknown>).stage, 'review');

  // ── narration happy path: fullScript preferred, real audio on disk, tolerance satisfied ──
  const narrationDraft = createFinalVideoDraft({
    projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-full',
    workflowConfig: narrationWorkflowConfig({ targetDurationSec: 5.5 }),
  });
  const narrationResult = await prepare(narrationDraft.id, 0);
  assert.equal(narrationResult.status, 200);
  const narrationBody = narrationResult.body.draft as Record<string, unknown>;
  assert.equal(narrationBody.stage, 'narration-ready');
  assert.equal(narrationBody.revision, 2);
  const beats = narrationBody.narrationBeats as Array<Record<string, unknown>>;
  assert.equal(beats.length, 2, 'one beat per synthesized natural sentence, no splitting under maxClipSeconds');
  for (const beat of beats) {
    assert.ok(fs.existsSync(beat.audioPath as string), `audio file must exist on disk: ${beat.audioPath}`);
    assert.ok((beat.durationSec as number) > 2 && (beat.durationSec as number) < 3, `real probed duration: ${beat.durationSec}`);
  }
  assert.equal((narrationBody.clipPool as unknown[]).length, 1);
  assert.deepEqual(narrationBody.issues, [], 'target duration chosen to stay inside tolerance');
  assert.equal(narrationCalls, 1, 'narration-script LLM called exactly once');
  assert.equal(ttsCalls, 2, 'TTS called exactly once per natural sentence');
  assert.match((narrationRequests[0].messages as Array<{ content: string }>)[1].content, /这是完整口播文案/);
  assert.equal(ttsRequests[0].voice, 'test-voice');
  assert.equal(ttsRequests[0].speed, 1.15, 'TTS speed must come from workflowConfig.packageConfig.narration, not a hardcoded default');

  // ── retry semantics: same draft, same workflowConfig, new revision -> reuse audio, no new calls ──
  const callsAfterFirstPrepare = { narrationCalls, ttsCalls };
  const retryResult = await prepare(narrationDraft.id, narrationBody.revision as number);
  assert.equal(retryResult.status, 200);
  const retryBody = retryResult.body.draft as Record<string, unknown>;
  assert.equal(retryBody.stage, 'narration-ready');
  assert.deepEqual(retryBody.narrationBeats, narrationBody.narrationBeats, 'reused beats must be identical to the first run');
  assert.equal(narrationCalls, callsAfterFirstPrepare.narrationCalls, 'retry must not call the narration-script LLM again');
  assert.equal(ttsCalls, callsAfterFirstPrepare.ttsCalls, 'retry must not call TTS again (avoid duplicate billing)');
  const rawRowAfterRetry = getFinalVideoDraft(narrationDraft.id)!;
  assert.equal(rawRowAfterRetry.narrationBeatsJson, JSON.stringify(narrationBody.narrationBeats), 'raw JSON column is byte-identical, not regenerated');

  // ── sourceText fallback: empty fullScript falls back to shots[].voiceover joined in order ──
  const fallbackDraft = createFinalVideoDraft({
    projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-fallback',
    workflowConfig: narrationWorkflowConfig({ targetDurationSec: 5.5 }),
  });
  const fallbackResult = await prepare(fallbackDraft.id, 0);
  assert.equal(fallbackResult.status, 200);
  assert.equal((fallbackResult.body.draft as Record<string, unknown>).stage, 'narration-ready');
  const fallbackPrompt = (narrationRequests.at(-1)!.messages as Array<{ content: string }>)[1].content;
  assert.match(fallbackPrompt, /第一句分镜台词/);
  assert.match(fallbackPrompt, /第二句分镜台词/);

  // ── duration tolerance exceeded: warning issue recorded, never a failure, audio not truncated ──
  const toleranceDraft = createFinalVideoDraft({
    projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-full',
    workflowConfig: narrationWorkflowConfig({ targetDurationSec: 50 }),
  });
  const toleranceResult = await prepare(toleranceDraft.id, 0);
  assert.equal(toleranceResult.status, 200);
  const toleranceBody = toleranceResult.body.draft as Record<string, unknown>;
  assert.equal(toleranceBody.stage, 'narration-ready');
  assert.equal((toleranceBody.narrationBeats as unknown[]).length, 2, 'audio must not be truncated');
  const toleranceIssues = toleranceBody.issues as Array<Record<string, unknown>>;
  assert.ok(toleranceIssues.some((issue) => issue.code === 'target_duration_out_of_tolerance' && issue.severity === 'warning'));

  // ── narration mode without scriptDraftId -> 400, stage/revision left untouched ──
  const noScriptDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: narrationWorkflowConfig() });
  assert.equal(noScriptDraft.scriptDraftId, null);
  const callsBeforeNoScript = { narrationCalls, ttsCalls };
  const noScriptResult = await prepare(noScriptDraft.id, 0);
  assert.equal(noScriptResult.status, 400);
  assert.match(String(noScriptResult.body.error), /口播.*脚本/);
  const noScriptRow = getFinalVideoDraft(noScriptDraft.id)!;
  assert.equal(noScriptRow.stage, 'draft');
  assert.equal(noScriptRow.revision, 0);
  assert.equal(narrationCalls, callsBeforeNoScript.narrationCalls);
  assert.equal(ttsCalls, callsBeforeNoScript.ttsCalls);

  // ── narration mode with empty script content (empty fullScript + empty/missing voiceover) -> 400 ──
  const emptyScriptDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-empty', workflowConfig: narrationWorkflowConfig() });
  const emptyScriptResult = await prepare(emptyScriptDraft.id, 0);
  assert.equal(emptyScriptResult.status, 400);
  assert.match(String(emptyScriptResult.body.error), /脚本内容为空/);
  const emptyScriptRow = getFinalVideoDraft(emptyScriptDraft.id)!;
  assert.equal(emptyScriptRow.stage, 'draft');
  assert.equal(emptyScriptRow.revision, 0);

  // ── stale revision -> 409, nothing mutated ──
  const staleDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: bgmWorkflowConfig() });
  const staleResult = await prepare(staleDraft.id, 5);
  assert.equal(staleResult.status, 409);
  assert.deepEqual(staleResult.body, { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' });
  const staleRow = getFinalVideoDraft(staleDraft.id)!;
  assert.equal(staleRow.stage, 'draft');
  assert.equal(staleRow.revision, 0);

  // ── missing draft -> 404 ──
  const missingResult = await prepare('missing-draft-id', 0);
  assert.equal(missingResult.status, 404);
  assert.equal(missingResult.body.error, '成片草稿不存在');

  // ── malformed request bodies -> 400 ──
  assert.equal((await responseFor(prepareRoute.POST(jsonRequest(null), ctx(bgmDraft.id)))).status, 400);
  assert.equal((await responseFor(prepareRoute.POST(jsonRequest({ revision: -1 }), ctx(bgmDraft.id)))).status, 400);
  assert.equal((await responseFor(prepareRoute.POST(jsonRequest({ revision: 0.5 }), ctx(bgmDraft.id)))).status, 400);
  assert.equal((await responseFor(prepareRoute.POST(jsonRequest({}), ctx(bgmDraft.id)))).status, 400);

  // ── remote failure during TTS -> ends at stage=failed with an error message, route still returns 200 ──
  ttsFailureMode = 'http-error';
  const failDraft = createFinalVideoDraft({
    projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-full',
    workflowConfig: narrationWorkflowConfig({ targetDurationSec: 5.5 }),
  });
  const failResult = await prepare(failDraft.id, 0);
  assert.equal(failResult.status, 200, 'a remote/file failure must not surface as an HTTP 500');
  const failBody = failResult.body.draft as Record<string, unknown>;
  assert.equal(failBody.stage, 'failed');
  assert.ok(typeof failBody.errorMessage === 'string' && (failBody.errorMessage as string).length > 0);
  assert.equal(failBody.revision, 2);
  ttsFailureMode = 'none';

  globalThis.fetch = originalFetch;
  console.log('final-video-prepare tests passed');
} finally {
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
