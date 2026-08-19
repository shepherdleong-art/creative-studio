import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const retryRoute = fs.readFileSync('app/api/video-jobs/[id]/retry/route.ts', 'utf8');
assert.doesNotMatch(retryRoute, /defaultModel/, 'retry must not read the provider default model');
assert.doesNotMatch(retryRoute, /SET status = 'pending', model =/, 'retry must not overwrite the frozen task model');
assert.match(retryRoute, /SET status = 'pending', errorMessage = NULL/, 'retry must only reset execution state');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-video-multi-shot-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;

const dbModule = await import('../lib/db.ts');
const queueModule = await import('../lib/video-queue.ts');
const providersModule = await import('../lib/video-providers/index.ts');

const db = dbModule.getDb();
db.prepare(`
  INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled)
  VALUES ('multi-shot-image-provider', '图片供应商', 'http://fake.example', 'fake-key', 'image-model', 'openai-compatible', 1)
`).run();
db.prepare(`
  INSERT INTO projects (id, name, providerId, model, prompt)
  VALUES ('multi-shot-project', '测试项目', 'multi-shot-image-provider', 'image-model', 'prompt')
`).run();

db.prepare(`
  INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
  VALUES ('multi-shot-image', 'multi-shot-project', 'input', 'source.png', '/tmp/source.png', 'image/png')
`).run();

db.prepare(`
  INSERT INTO video_providers
    (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, baseUrl, apiKey, accessKey, secretKey)
  VALUES ('multi-shot-video-provider', '公司视频供应商', 'openai-video', '', '', '', 'kling-3.0', 1, 'http://fake.example', 'fake-key', '', '')
`).run();

const captured = new Map<string, Record<string, unknown>>();
providersModule.registerTestVideoAdapter('openai-video', {
  submit: async (request) => {
    captured.set(request.prompt, request as unknown as Record<string, unknown>);
    return { providerTaskId: `remote-${request.prompt}`, rawResponse: null };
  },
  poll: async () => ({ status: 'failed', errorMessage: 'test complete', rawResponse: null }),
  minimumPollingTimeoutMs: () => 0,
});

for (const [id, multiShot, prompt] of [
  ['multi-shot-on', 1, 'multi-shot-on-prompt'],
  ['multi-shot-off', 0, 'multi-shot-off-prompt'],
  ['multi-shot-null', null, 'multi-shot-null-prompt'],
] as const) {
  db.prepare(`
    INSERT INTO video_jobs
      (id, projectId, sourceImageId, providerId, model, prompt, durationSec, status, multiShot)
    VALUES (?, 'multi-shot-project', 'multi-shot-image', 'multi-shot-video-provider', 'kling-3.0', ?, 5, 'pending', ?)
  `).run(id, prompt, multiShot);
}

await queueModule.runVideoQueue({
  projectId: 'multi-shot-project',
  concurrency: 3,
  timeoutMs: 60_000,
});

assert.deepEqual(captured.get('multi-shot-on-prompt')?.multiShot, true, 'stored 1 must reach the adapter as true');
assert.deepEqual(captured.get('multi-shot-off-prompt')?.multiShot, false, 'stored 0 must reach the adapter as false');
assert.equal(
  Object.prototype.hasOwnProperty.call(captured.get('multi-shot-null-prompt') ?? {}, 'multiShot'),
  false,
  'stored NULL must omit the optional adapter field',
);

const frozen = db.prepare(`SELECT model, multiShot FROM video_jobs WHERE id = 'multi-shot-off'`).get() as {
  model: string;
  multiShot: number | null;
};
assert.deepEqual(frozen, { model: 'kling-3.0', multiShot: 0 });

dbModule.closeDb();
fs.rmSync(dataRoot, { recursive: true, force: true });

console.log('video queue multi-shot tests passed');
