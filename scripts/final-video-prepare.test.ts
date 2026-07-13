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

  // Shared narration text for the two v2 segments below; also what actually gets sent to TTS
  // (there is no LLM re-split step anymore — the script's plan already is the sentence list).
  const SENTENCES = ['这是第一句测试口播文本，用于验证流程。', '这是第二句测试口播文本，同样验证流程。'];

  // v2 shape: segments[] IS the plan, in script order. Two segments -> two shots -> two beats,
  // each pointing at the shot whose image the script actually saw (imageAssetId), so the
  // resulting arrangement has zero staleness/substitution issues (see build-arrangement.ts).
  scriptDraft('script-plan', {
    version: 2,
    segments: [
      { shotId: 'shot-1', imageAssetId: 'image-1', narration: SENTENCES[0], rationale: '开场展示商品全貌' },
      { shotId: 'shot-2', imageAssetId: 'image-2', narration: SENTENCES[1], rationale: '特写展示细节' },
    ],
    droppedShots: [],
  });
  // Legacy shape (no version:2): parseScriptPlan's legacy adapter reads shots[].voiceover 1:1
  // into segments and forces imageAssetId null. That adapter's own edge cases are already
  // covered by final-video-script-plan.test.ts (Task B3) — this fixture only exists so this
  // file can prove prepare-draft.ts wires the adapter's output through end-to-end.
  scriptDraft('script-legacy', {
    shots: [
      { shotId: 'shot-1', voiceover: '第一句分镜台词。' },
      { shotId: 'shot-2', voiceover: '第二句分镜台词。' },
    ],
  });
  scriptDraft('script-empty', { fullScript: '', shots: [{ voiceover: '' }, {}] });
  scriptDraft('script-broken', '{not valid json');

  // ── Fixtures: two shots, each with a succeeded video job, so a two-segment script plan maps
  // 1:1 onto two distinct clips (matching imageAssetId <-> sourceImageId, zero substitution/
  // staleness issues). Both video jobs point at the same physical media file — ffprobe only
  // needs a valid video at the path, it doesn't care whether two jobs share one file. ──
  const storage = path.join(testRoot, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  const media = path.join(storage, 'clip.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=25:d=1.5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media]);
  for (const n of [1, 2]) {
    const imagePath = path.join(storage, `image-${n}.png`);
    fs.writeFileSync(imagePath, 'image fixture');
    db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path) VALUES (?, 'project-1', 'output', ?, ?)`)
      .run(`image-${n}`, `image-${n}.png`, imagePath);
    db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, latestGeneratedImageId) VALUES (?, 'shot-set-1', ?, ?, ?)`)
      .run(`shot-${n}`, n - 1, `image-${n}`, `image-${n}`);
    db.prepare(`
      INSERT INTO video_jobs (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, prompt, durationSec, status, localVideoPath, createdAt, finishedAt)
      VALUES (?, 'project-1', 'shot-set-1', ?, ?, 'video-provider', 'model', '', 5, 'succeeded', ?, '2026-01-01 00:00:00', '2026-01-01 00:01:00')
    `).run(`video-job-${n}`, `shot-${n}`, `image-${n}`, media);
  }

  // ── Fixtures: TTS source audio (real, via lavfi) reused for every synthesized sentence ──
  const ttsSourceWav = path.join(testRoot, 'tts-source.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5', '-c:a', 'pcm_s16le', '-y', ttsSourceWav]);
  const ttsSourceBytes = fs.readFileSync(ttsSourceWav);

  // ── fetch mock: only /audio/speech is a real endpoint prepare-draft.ts calls now. There is
  // deliberately no /chat/completions branch — prepare-draft.ts no longer calls any LLM to
  // re-split narration into sentences (the script's v2 plan already is the sentence list). If
  // prepare-draft.ts ever regresses and calls an LLM again, this mock throws immediately via the
  // fallback branch below instead of silently answering it. ──
  const originalFetch = globalThis.fetch;
  let ttsCalls = 0;
  const ttsRequests: Array<Record<string, unknown>> = [];
  let ttsFailureMode: 'none' | 'http-error' = 'none';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
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

  // ── bgm-only happy path: never touches narration/TTS, ends in review, arrangement untouched ──
  const bgmDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: bgmWorkflowConfig() });
  assert.equal(bgmDraft.stage, 'draft');
  assert.deepEqual(JSON.parse(bgmDraft.arrangementJson), { assignments: [], gaps: [] }, 'fresh draft starts with the empty arrangement default');
  const bgmResult = await prepare(bgmDraft.id, 0);
  assert.equal(bgmResult.status, 200);
  const bgmBody = bgmResult.body.draft as Record<string, unknown>;
  assert.equal(bgmBody.stage, 'review');
  assert.equal(bgmBody.revision, 2, 'preparing bump + final patch = +2 revisions');
  assert.deepEqual(bgmBody.narrationBeats, []);
  assert.equal((bgmBody.clipPool as unknown[]).length, 2);
  assert.equal((bgmBody.clipPool as Array<Record<string, unknown>>)[0].clipId, 'video-job-1');
  assert.equal((bgmBody.clipPool as Array<Record<string, unknown>>)[1].clipId, 'video-job-2');
  assert.deepEqual(bgmBody.issues, []);
  assert.deepEqual(bgmBody.arrangement, { assignments: [], gaps: [] }, 'bgm-only never runs the script-driven arrangement step: arrangementJson is left exactly as the draft default, not recomputed to an equivalent-looking empty value');
  assert.equal(ttsCalls, 0, 'bgm-only must never call TTS');

  // ── bgm-only with a scriptDraftId pointing at genuinely broken JSON: must still never read it ──
  const bgmBrokenDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-broken', workflowConfig: bgmWorkflowConfig() });
  const bgmBrokenResult = await prepare(bgmBrokenDraft.id, 0);
  assert.equal(bgmBrokenResult.status, 200, 'bgm-only must never parse the script draft, even if it is malformed JSON');
  assert.equal((bgmBrokenResult.body.draft as Record<string, unknown>).stage, 'review');

  // ── narration happy path: script plan segments map 1:1 to beats, real audio on disk, tolerance
  // satisfied, arrangement assigns each beat its own planned clip with zero issues ──
  const narrationDraft = createFinalVideoDraft({
    projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-plan',
    workflowConfig: narrationWorkflowConfig({ targetDurationSec: 5.5 }),
  });
  const narrationResult = await prepare(narrationDraft.id, 0);
  assert.equal(narrationResult.status, 200);
  const narrationBody = narrationResult.body.draft as Record<string, unknown>;
  assert.equal(narrationBody.stage, 'review');
  assert.equal(narrationBody.revision, 2);
  const beats = narrationBody.narrationBeats as Array<Record<string, unknown>>;
  assert.equal(beats.length, 2, 'one beat per script segment, 1:1, no LLM re-split');
  assert.equal(beats[0].shotId, 'shot-1');
  assert.equal(beats[0].imageAssetId, 'image-1');
  assert.equal(beats[1].shotId, 'shot-2');
  assert.equal(beats[1].imageAssetId, 'image-2');
  for (const beat of beats) {
    assert.ok(fs.existsSync(beat.audioPath as string), `audio file must exist on disk: ${beat.audioPath}`);
    assert.ok((beat.durationSec as number) > 2 && (beat.durationSec as number) < 3, `real probed duration: ${beat.durationSec}`);
  }
  assert.equal((narrationBody.clipPool as unknown[]).length, 2);
  assert.deepEqual(narrationBody.issues, [], 'target duration chosen to stay inside tolerance, and the plan maps cleanly onto the clip pool');
  assert.equal(ttsCalls, 2, 'TTS called exactly once per script segment');
  assert.equal(ttsRequests[0].voice, 'test-voice');
  assert.equal(ttsRequests[0].speed, 1.15, 'TTS speed must come from workflowConfig.packageConfig.narration, not a hardcoded default');

  // arrangement is built deterministically from the plan: each beat gets the clip for its own
  // shotId, in script order, with no substitution or gaps needed (substitution/gap/staleness
  // edge cases themselves are covered by final-video-build-arrangement.test.ts, Task B4).
  const narrationArrangement = narrationBody.arrangement as { assignments: Array<Record<string, unknown>>; gaps: unknown[] };
  assert.equal(narrationArrangement.assignments.length, 2, 'arrangement must have one assignment per beat');
  assert.deepEqual(narrationArrangement.assignments.map((a) => a.clipId), ['video-job-1', 'video-job-2']);
  assert.deepEqual(narrationArrangement.assignments.map((a) => a.beatIds), [['beat-0'], ['beat-1']]);
  assert.deepEqual(narrationArrangement.gaps, []);

  // ── retry semantics: same draft, same workflowConfig, new revision -> reuse audio, no new TTS
  // calls; arrangement is cheap/deterministic so it's recomputed anyway, byte-identically ──
  const callsAfterFirstPrepare = { ttsCalls };
  const retryResult = await prepare(narrationDraft.id, narrationBody.revision as number);
  assert.equal(retryResult.status, 200);
  const retryBody = retryResult.body.draft as Record<string, unknown>;
  assert.equal(retryBody.stage, 'review');
  assert.deepEqual(retryBody.narrationBeats, narrationBody.narrationBeats, 'reused beats must be identical to the first run');
  assert.equal(ttsCalls, callsAfterFirstPrepare.ttsCalls, 'retry must not call TTS again (avoid duplicate billing)');
  assert.deepEqual(retryBody.arrangement, narrationBody.arrangement, 'same beats + same clip pool + same dropped shots recomputes to an identical arrangement');
  const rawRowAfterRetry = getFinalVideoDraft(narrationDraft.id)!;
  assert.equal(rawRowAfterRetry.narrationBeatsJson, JSON.stringify(narrationBody.narrationBeats), 'raw JSON column is byte-identical, not regenerated');
  assert.equal(rawRowAfterRetry.arrangementJson, JSON.stringify(narrationBody.arrangement), 'raw arrangementJson column is byte-identical across the deterministic recompute');

  // ── legacy script shape (no version:2): parseScriptPlan's legacy adapter reads shots[].voiceover
  // 1:1 into segments with imageAssetId forced null. That adapter's own edge cases already have
  // dedicated coverage (Task B3) — this block only proves prepare-draft.ts wires the adapter's
  // output through end-to-end: beats, TTS, and arrangement all still work. ──
  const legacyDraft = createFinalVideoDraft({
    projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-legacy',
    workflowConfig: narrationWorkflowConfig({ targetDurationSec: 5.5 }),
  });
  const legacyResult = await prepare(legacyDraft.id, 0);
  assert.equal(legacyResult.status, 200);
  const legacyBody = legacyResult.body.draft as Record<string, unknown>;
  assert.equal(legacyBody.stage, 'review');
  const legacyBeats = legacyBody.narrationBeats as Array<Record<string, unknown>>;
  assert.equal(legacyBeats.length, 2, 'one beat per legacy shot, no windowing');
  assert.equal(legacyBeats[0].text, '第一句分镜台词。');
  assert.equal(legacyBeats[1].text, '第二句分镜台词。');
  assert.equal(legacyBeats[0].imageAssetId, null, 'legacy segments never know which image the script saw');
  assert.equal(legacyBeats[1].imageAssetId, null);
  const legacyArrangement = legacyBody.arrangement as { assignments: Array<Record<string, unknown>>; gaps: unknown[] };
  assert.equal(legacyArrangement.assignments.length, 2, 'legacy beats still arrange cleanly against the clip pool');
  assert.deepEqual(legacyArrangement.gaps, []);

  // ── duration tolerance exceeded: warning issue recorded, never a failure, audio not truncated ──
  const toleranceDraft = createFinalVideoDraft({
    projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-plan',
    workflowConfig: narrationWorkflowConfig({ targetDurationSec: 50 }),
  });
  const toleranceResult = await prepare(toleranceDraft.id, 0);
  assert.equal(toleranceResult.status, 200);
  const toleranceBody = toleranceResult.body.draft as Record<string, unknown>;
  assert.equal(toleranceBody.stage, 'review');
  assert.equal((toleranceBody.narrationBeats as unknown[]).length, 2, 'audio must not be truncated');
  const toleranceIssues = toleranceBody.issues as Array<Record<string, unknown>>;
  assert.ok(toleranceIssues.some((issue) => issue.code === 'target_duration_out_of_tolerance' && issue.severity === 'warning'));

  // ── narration mode without scriptDraftId -> 400, stage/revision left untouched ──
  const noScriptDraft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: narrationWorkflowConfig() });
  assert.equal(noScriptDraft.scriptDraftId, null);
  const callsBeforeNoScript = { ttsCalls };
  const noScriptResult = await prepare(noScriptDraft.id, 0);
  assert.equal(noScriptResult.status, 400);
  assert.match(String(noScriptResult.body.error), /口播.*脚本/);
  const noScriptRow = getFinalVideoDraft(noScriptDraft.id)!;
  assert.equal(noScriptRow.stage, 'draft');
  assert.equal(noScriptRow.revision, 0);
  assert.equal(ttsCalls, callsBeforeNoScript.ttsCalls);

  // ── narration mode with a legacy-shape script draft that has no usable shots -> 400 ──
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
    projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: 'script-plan',
    workflowConfig: narrationWorkflowConfig({ targetDurationSec: 5.5 }),
  });
  const failResult = await prepare(failDraft.id, 0);
  assert.equal(failResult.status, 200, 'a remote/file failure must not surface as an HTTP 500');
  const failBody = failResult.body.draft as Record<string, unknown>;
  assert.equal(failBody.stage, 'failed');
  assert.ok(typeof failBody.errorMessage === 'string' && (failBody.errorMessage as string).length > 0);
  assert.equal(failBody.revision, 2);
  ttsFailureMode = 'none';

  // ── errorMessage from a previous failure must not linger once prepare succeeds again ──
  assert.ok((failBody.errorMessage as string).length > 0, 'sanity: previous case really did fail with a message');
  const recoveredResult = await prepare(failDraft.id, failBody.revision as number);
  assert.equal(recoveredResult.status, 200);
  const recoveredBody = recoveredResult.body.draft as Record<string, unknown>;
  assert.equal(recoveredBody.stage, 'review');
  assert.equal(recoveredBody.errorMessage, null, 'a successful re-prepare must clear the stale errorMessage');

  globalThis.fetch = originalFetch;
  console.log('final-video-prepare tests passed');
} finally {
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
