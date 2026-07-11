import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-describe-api-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const describeRoute = await import('../app/api/final-video-drafts/[id]/describe/route.ts');
const { getDb } = await import('../lib/db.ts');
const { defaultPackageConfig } = await import('../lib/final-video/types.ts');
const { createFinalVideoDraft, getFinalVideoDraft } = await import('../lib/final-video/draft-store.ts');

const db = getDb();
const storage = path.join(testRoot, 'storage');
fs.mkdirSync(storage, { recursive: true });

function configureProvider(id: string, input: { supportsVision: boolean; configured: boolean; model?: string }): void {
  db.prepare(`UPDATE script_providers SET baseUrl = ?, apiKey = ?, model = ?, apiStyle = 'openai-compatible', enabled = 1, supportsVision = ? WHERE id = ?`)
    .run(input.configured ? `https://${id}.example/api` : '', input.configured ? `${id}-key` : '', input.model || `${id}-model`, input.supportsVision ? 1 : 0, id);
}

function workflow(visionProviderId = 'qwen') {
  return {
    packageConfig: defaultPackageConfig(),
    narrationScriptProviderId: 'qwen',
    visionProviderId,
    orchestrationProviderId: 'qwen',
    selectedClipIds: [],
  };
}

function clip(input: { clipId: string; imageId: string; imagePath: string }) {
  return {
    clipId: input.clipId,
    shotId: `shot-${input.clipId}`,
    shotIndex: 0,
    videoPath: `/video/${input.clipId}.mp4`,
    clipDurationSec: 2,
    sourceImageId: input.imageId,
    sourceImagePath: input.imagePath,
    visualDescription: '',
    descriptionProviderId: null,
    descriptionModel: null,
  };
}

async function image(name: string): Promise<string> {
  const imagePath = path.join(storage, name);
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 30, b: 40 } } }).png().toFile(imagePath);
  return imagePath;
}

function seedDraft(input: { providerId?: string; clips: ReturnType<typeof clip>[]; revision?: number } ) {
  const draft = createFinalVideoDraft({ projectId: 'project-1', shotSetId: 'shot-set-1', scriptDraftId: null, workflowConfig: workflow(input.providerId) });
  db.prepare(`UPDATE final_video_drafts SET stage = 'narration-ready', revision = ?, clipPoolJson = ?, arrangementJson = ?, issuesJson = ?, previewJobId = 'preview-job', previewRevision = 0 WHERE id = ?`)
    .run(input.revision ?? 0, JSON.stringify(input.clips), JSON.stringify({ assignments: [{ assignmentId: 'a-1', clipId: input.clips[0]?.clipId || 'none', beatIds: [] }], gaps: [] }), JSON.stringify([{ code: 'visual_gap', severity: 'warning', message: 'old issue', beatIds: [], clipId: null }]), draft.id);
  return getFinalVideoDraft(draft.id)!;
}

function request(body: unknown): Request {
  return new Request('http://test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function ctx(id: string) { return { params: Promise.resolve({ id }) }; }
async function result(pending: Promise<Response>) { const response = await pending; return { status: response.status, body: await response.json() as Record<string, unknown> }; }
async function describe(id: string, body: unknown) { return result(describeRoute.POST(request(body), ctx(id))); }

const originalFetch = globalThis.fetch;
let resolveFetch!: () => void;
const fetchReleased = new Promise<void>((resolve) => { resolveFetch = resolve; });
let fetchStarted: (() => void) | null = null;
globalThis.fetch = (async () => {
  fetchStarted?.();
  await fetchReleased;
  return Response.json({ choices: [{ message: { content: '远程识别的主图：白色杯子。' } }] });
}) as typeof fetch;

try {
  db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl, model) VALUES ('provider', 'Provider', '', 'model')`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-1', 'Project', 'provider', 'model', '')`).run();
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('shot-set-1', 'project-1', 'One')`).run();
  db.prepare(`INSERT INTO final_video_jobs (id, projectId, shotSetId) VALUES ('preview-job', 'project-1', 'shot-set-1')`).run();
  configureProvider('qwen', { supportsVision: true, configured: true, model: 'vision-model' });
  configureProvider('kimi', { supportsVision: false, configured: true });
  configureProvider('gemini', { supportsVision: true, configured: false });

  const firstImage = await image('first.png');
  const secondImage = await image('second.png');
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path) VALUES ('image-1', 'project-1', 'output', 'first.png', ?), ('image-2', 'project-1', 'output', 'second.png', ?), ('image-3', 'project-1', 'output', 'first-copy.png', ?)`)
    .run(firstImage, secondImage, firstImage);

  // Provider validation occurs before the temporary describing state is persisted.
  const noVision = seedDraft({ providerId: 'kimi', clips: [clip({ clipId: 'clip-1', imageId: 'image-1', imagePath: firstImage })] });
  assert.equal((await describe(noVision.id, { revision: 0 })).status, 400);
  assert.deepEqual(getFinalVideoDraft(noVision.id), noVision);
  const unconfigured = seedDraft({ providerId: 'gemini', clips: [clip({ clipId: 'clip-2', imageId: 'image-1', imagePath: firstImage })] });
  assert.equal((await describe(unconfigured.id, { revision: 0 })).status, 400);
  assert.deepEqual(getFinalVideoDraft(unconfigured.id), unconfigured);
  assert.equal((await describe('missing', { revision: 0 })).status, 404);
  assert.equal((await describe(noVision.id, {})).status, 400);
  assert.equal((await describe(noVision.id, { revision: -1 })).status, 400);
  assert.equal((await describe(noVision.id, { revision: 0, force: 'yes' })).status, 400);

  // The in-flight stage is durable; success returns to narration-ready, increments twice,
  // writes description provenance, and invalidates all derived arrangement/preview state.
  const success = seedDraft({ clips: [clip({ clipId: 'clip-success', imageId: 'image-1', imagePath: firstImage })] });
  let markFetchStarted!: () => void;
  const started = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  fetchStarted = markFetchStarted;
  const pending = describe(success.id, { revision: 0 });
  await started;
  const inFlight = getFinalVideoDraft(success.id)!;
  assert.equal(inFlight.stage, 'describing');
  assert.equal(inFlight.revision, 1);
  resolveFetch();
  const successResult = await pending;
  assert.equal(successResult.status, 200);
  const successDraft = successResult.body.draft as Record<string, unknown>;
  assert.equal(successDraft.stage, 'narration-ready');
  assert.equal(successDraft.revision, 2);
  assert.deepEqual(successDraft.arrangement, { assignments: [], gaps: [] });
  assert.deepEqual(successDraft.issues, []);
  assert.equal(successDraft.previewJobId, null);
  assert.equal(successDraft.previewRevision, null);
  assert.equal(successDraft.errorMessage, null);
  assert.deepEqual(successDraft.clipPool, [{ ...clip({ clipId: 'clip-success', imageId: 'image-1', imagePath: firstImage }), visualDescription: '远程识别的主图：白色杯子。', descriptionProviderId: 'qwen', descriptionModel: 'vision-model' }]);

  // Partial failure persists already successful cache-backed descriptions and leaves the
  // draft failed with all derived state invalidated, while retaining C1 cache entries.
  db.prepare(`INSERT INTO clip_visual_descriptions (id, imageAssetId, description, providerId, model) VALUES ('cache-1', 'image-2', '缓存中的成功描述。', 'qwen', 'vision-model')`).run();
  const partial = seedDraft({ clips: [
    clip({ clipId: 'clip-cached', imageId: 'image-2', imagePath: secondImage }),
    clip({ clipId: 'clip-bad-path', imageId: 'image-3', imagePath: '/outside/data-root.png' }),
  ] });
  const partialResult = await describe(partial.id, { revision: 0 });
  assert.equal(partialResult.status, 200);
  const partialDraft = partialResult.body.draft as Record<string, unknown>;
  assert.equal(partialDraft.stage, 'failed');
  assert.equal(partialDraft.revision, 2);
  assert.match(partialDraft.errorMessage as string, /clip-bad-path/);
  assert.deepEqual((partialDraft.clipPool as Array<Record<string, unknown>>)[0], { ...clip({ clipId: 'clip-cached', imageId: 'image-2', imagePath: secondImage }), visualDescription: '缓存中的成功描述。', descriptionProviderId: 'qwen', descriptionModel: 'vision-model' });
  assert.equal((partialDraft.clipPool as Array<Record<string, unknown>>)[1].visualDescription, '');
  assert.deepEqual(partialDraft.arrangement, { assignments: [], gaps: [] });
  assert.deepEqual(partialDraft.issues, []);
  assert.equal(partialDraft.previewJobId, null);
  assert.equal(partialDraft.previewRevision, null);
  assert.deepEqual(db.prepare(`SELECT description FROM clip_visual_descriptions WHERE imageAssetId = 'image-2' AND providerId = 'qwen' AND model = 'vision-model'`).get(), { description: '缓存中的成功描述。' });

  // Optimistic locking applies to the initial transition and returns the shared API contract.
  assert.deepEqual(await describe(success.id, { revision: 0 }), {
    status: 409,
    body: { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' },
  });

  console.log('final-video-describe-api tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
