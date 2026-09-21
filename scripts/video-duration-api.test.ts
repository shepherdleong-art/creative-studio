import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import Database from 'better-sqlite3';
import * as duration from '../lib/video-duration.ts';

// Execute the real route handlers with isolated SQLite and no queue/network side effects.
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE shots(id TEXT, shotSetId TEXT, sourceImageId TEXT, latestGeneratedImageId TEXT);
  INSERT INTO shots VALUES ('shot','set','image',NULL);
  CREATE TABLE shot_sets(id TEXT, projectId TEXT);
  INSERT INTO shot_sets VALUES ('set','project');
  CREATE TABLE video_providers(id TEXT, name TEXT, type TEXT, defaultModel TEXT, enabled INTEGER);
  CREATE TABLE video_jobs(id TEXT, projectId TEXT, shotSetId TEXT, shotId TEXT, sourceImageId TEXT,
    tailImageId TEXT, providerId TEXT, model TEXT, templateId TEXT, prompt TEXT, durationSec REAL,
    multiShot INTEGER, createdAt TEXT, displayName TEXT);
`);
for (const [id, model] of [['sd25','doubao-seedance-2-5-260628'], ['sd20','doubao-seedance-2-0-260128'],
  ['fast','doubao-seedance-2-0-fast-260128'], ['kling','kling-3.0']]) {
  db.prepare('INSERT INTO video_providers VALUES (?, ?, ?, ?, 1)').run(id, id, 'openai-video', model);
}
const dependencies: Record<string, unknown> = {
  'next/server': { NextResponse: { json: (data: unknown, init?: ResponseInit) => Response.json(data, init) } },
  '@/lib/db': { getDb: () => db }, 'uuid': { v4: randomUUID },
  '@/lib/video-queue': { getVideoQueueStatus: () => 'running', runVideoQueue: () => { throw new Error('Unexpected queue start'); } },
  '@/lib/storage-url': {}, '@/lib/video-duration': duration,
  '@/lib/video-auth': { getVideoProviderConfigState: () => ({ configured: true }) },
  '@/lib/video-tail-frame': { validateVideoTailFrameAsset: () => ({ ok: true }), validateVideoTailFrameBatchDrafts: () => null },
  '@/lib/video-multi-shot': { normalizeVideoMultiShotForStorage: () => null },
  '@/lib/video-output-filenames': { countVideoJobsForShot: () => 0, planVideoJobDisplayName: () => 'test.mp4' },
};
function loadRoute(file: string) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: { POST?: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> } = {};
  vm.runInNewContext(code, { exports, console, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return exports.POST!;
}
const single = loadRoute('app/api/shot-sets/[id]/video-jobs/route.ts');
const batch = loadRoute('app/api/shot-sets/[id]/video-jobs/batch/route.ts');
async function submit(handler: typeof single, body: unknown) {
  db.exec('DELETE FROM video_jobs');
  return handler(new Request('http://localhost/test', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'set' }) });
}
try {
  for (const [providerId, min, max] of [['sd25',4,30], ['sd20',4,15], ['fast',4,15], ['kling',3,15]] as const) {
    for (const seconds of [min, max, min - 1, max + 1, 4.5, 'bad', null, '']) {
      const valid = seconds === min || seconds === max;
      for (const handler of [single, batch]) {
        const item = { providerId, prompt: 'test', durationSec: seconds };
        const body = handler === single ? { shotId: 'shot', ...item } : { shotId: 'shot', items: [item] };
        const response = await submit(handler, body);
        assert.equal(response.status, valid ? 200 : 400, `${providerId} ${seconds}: ${await response.text()}`);
        const stored = db.prepare('SELECT durationSec FROM video_jobs').all() as { durationSec: number }[];
        assert.deepEqual(stored.map(r => r.durationSec), valid ? [seconds] : []);
      }
    }
  }
  for (const fastDuration of [15, 30]) {
    const response = await submit(batch, { shotId: 'shot', items: [
      { providerId: 'sd25', prompt: 'test', durationSec: 30 },
      { providerId: 'fast', prompt: 'test', durationSec: fastDuration },
    ] });
    assert.equal(response.status, fastDuration === 15 ? 200 : 400);
    const stored = db.prepare('SELECT durationSec FROM video_jobs').all() as { durationSec: number }[];
    assert.deepEqual(stored.map(r => r.durationSec), fastDuration === 15 ? [30, 15] : []);
  }
  console.log('video-duration API tests passed');
} finally { db.close(); }
