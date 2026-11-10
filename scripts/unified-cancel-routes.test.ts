import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-cancel-routes-'));
const previousEnv = { ...process.env };
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';

const { getDb, closeDb } = await import('../lib/db.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const {
  applyUnifiedImageJobCancel,
  applyUnifiedKlingJobCancel,
} = await import('../lib/media-core/unified-media/cancel-intent.ts');

try {
  const db = getDb();
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
    VALUES ('provider', 'test', 'https://example.test', '', 'key', 'image2', 'gateway-task-image', 1)`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt)
    VALUES ('project', 'project', 'provider', 'image2', 'prompt')`).run();
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
    VALUES ('input', 'project', 'input', 'input.png', ?, 'image/png')`).run(path.join(root, 'input.png'));
  db.prepare(`INSERT INTO video_providers (
    id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, baseUrl, apiKey
  ) VALUES ('video-provider', 'video', 'openai-video', '', '', '', 'kling-3.0', 1, 'https://example.test', 'key')`).run();
  db.prepare(`INSERT INTO jobs (
    id, projectId, inputImageId, providerId, model, prompt, status, unifiedModel,
    providerTaskId, createdAt
  ) VALUES ('image-accepted', 'project', 'input', 'provider', 'image2', 'prompt', 'running', 'image2', 'remote-image', ?)`).run(now);
  db.prepare(`INSERT INTO jobs (
    id, projectId, inputImageId, providerId, model, prompt, status, unifiedModel, createdAt
  ) VALUES ('image-pending', 'project', 'input', 'provider', 'image2', 'prompt', 'pending', 'image2', ?)`).run(now);
  db.prepare(`INSERT INTO video_jobs (
    id, projectId, sourceImageId, providerId, model, prompt, durationSec, status,
    unifiedModel, providerTaskId, createdAt
  ) VALUES ('video-accepted', 'project', 'input', 'video-provider', 'kling-3.0', 'prompt', 5,
    'running', 'kling-3.0', 'remote-video', ?)`).run(now);
  db.prepare(`INSERT INTO video_jobs (
    id, projectId, sourceImageId, providerId, model, prompt, durationSec, status,
    unifiedModel, createdAt
  ) VALUES ('video-pending', 'project', 'input', 'video-provider', 'kling-3.0', 'prompt', 5,
    'pending', 'kling-3.0', ?)`).run(now);

  {
    const result = applyUnifiedImageJobCancel(db, 'image-accepted');
    assert.equal(result?.acceptedSubmittedWork, true);
    const job = db.prepare(`SELECT status, cancelRequestedAt, errorMessage
      FROM jobs WHERE id = 'image-accepted'`).get() as {
        status: string; cancelRequestedAt: string | null; errorMessage: string | null;
      };
    assert.equal(job.status, 'running', 'accepted image keeps settling');
    assert.ok(job.cancelRequestedAt);
    assert.match(job.errorMessage ?? '', /收尾|保留/);
    const repeated = applyUnifiedImageJobCancel(db, 'image-accepted');
    assert.equal(repeated?.idempotent, true);
  }
  {
    applyUnifiedImageJobCancel(db, 'image-pending');
    const job = db.prepare(`SELECT status, cancelRequestedAt FROM jobs WHERE id = 'image-pending'`).get() as {
      status: string; cancelRequestedAt: string | null;
    };
    assert.equal(job.status, 'canceled');
    assert.ok(job.cancelRequestedAt);
  }
  {
    const result = applyUnifiedKlingJobCancel(db, 'video-accepted');
    assert.equal(result?.acceptedSubmittedWork, true);
    const job = db.prepare(`SELECT status, cancelRequestedAt, errorMessage
      FROM video_jobs WHERE id = 'video-accepted'`).get() as {
        status: string; cancelRequestedAt: string | null; errorMessage: string | null;
      };
    assert.equal(job.status, 'running', 'accepted video keeps settling');
    assert.ok(job.cancelRequestedAt);
    assert.match(job.errorMessage ?? '', /收尾|保留/);
    const repeated = applyUnifiedKlingJobCancel(db, 'video-accepted');
    assert.equal(repeated?.idempotent, true);
  }
  {
    applyUnifiedKlingJobCancel(db, 'video-pending');
    const job = db.prepare(`SELECT status, cancelRequestedAt FROM video_jobs WHERE id = 'video-pending'`).get() as {
      status: string; cancelRequestedAt: string | null;
    };
    assert.equal(job.status, 'canceled');
    assert.ok(job.cancelRequestedAt);
  }

  console.log('unified cancel routes tests passed');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
