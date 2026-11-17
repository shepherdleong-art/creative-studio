import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import Database from 'better-sqlite3';
import type { CanvasModelCapability } from '../lib/creative-canvas/capabilities.ts';

// Real team execution + media probing: defaults and automatic-duration settlement
// must reach the same usage totals as the canvas ledger, without remote requests.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-execution-usage-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'canvas-usage-test',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'fixture',
});
register('./typescript-extension-loader.mjs', import.meta.url);
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { ensureCreativeCanvasSchemaReady } = await import('../lib/creative-canvas/schema.ts');
const { initUsageSchema } = await import('../lib/usage-schema.ts');
const { createTeamExecutionRuntime } = await import('../lib/team-service/bootstrap.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { legacyMediaProviderPoolKey, legacyMediaProviderCredentialFingerprint } = await import('../lib/media-core/execution/media-provider-pool.ts');
const { createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { clearCanvasCapabilities, registerCanvasCapability } = await import('../lib/creative-canvas/capabilities.ts');
const { COMPANY_CANVAS_SEEDANCE_2_0_FAST_CAPABILITY: legacyFast, COMPANY_CANVAS_NATIVE_VIDEO_CAPABILITIES } = await import('../lib/creative-canvas/adapters/company-capabilities.ts');
const { configuredCanvasVideos } = await import('../lib/creative-canvas/adapters/configured-videos.ts');
const { createCanvas, saveCanvasGraph } = await import('../lib/creative-canvas/repository.ts');
const { startCanvasRun } = await import('../lib/creative-canvas/runs.ts');
const { claimCanvasTasks, getCanvasTask } = await import('../lib/creative-canvas/tasks.ts');
const { runCanvasTask } = await import('../lib/creative-canvas/runner.ts');
const { canvasTaskCostQuote } = await import('../lib/creative-canvas/usage.ts');
const { requestCanvasTaskCancel, retryCanvasTaskDownload } = await import('../lib/creative-canvas/recovery.ts');
const { createCanvasFixtureAdapter } = await import('../lib/creative-canvas/adapters/fixture.ts');
const { queryTeamUsage } = await import('../lib/team-service/usage.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');

const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'canvas-backups') })).state, 'ready');
assert.equal(initUsageSchema(db).available, true);
db.exec(`CREATE TABLE video_providers (id TEXT PRIMARY KEY, name TEXT, type TEXT, baseUrl TEXT, defaultModel TEXT, enabled INTEGER DEFAULT 1, apiKey TEXT DEFAULT 'fixture')`);
const at = '2026-11-16T00:00:00.000Z';
db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash,
  mustChangePassword, sessionVersion, createdAt, updatedAt)
  VALUES ('alice', '0001', 'alice', 'employee', 'active', 'unused', 0, 1, ?, ?)`).run(at, at);
const access = createTeamAccessContext({ db, principal: {
  kind: 'user', userId: 'alice', employeeId: '0001', displayName: 'alice', role: 'employee',
  sessionId: 'session', sessionVersion: 1, mustChangePassword: false, absoluteExpiresAt: '2099-01-01T00:00:00Z',
} });
const identity = { instanceId: 'canvas-usage-test', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'canvas-usage-test' });
const runtime = createTeamExecutionRuntime({ db, config: {
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'canvas-usage-test', trustedOrigin: 'https://studio.example.test',
} });
await runtime.lifecycle.start({ ...identity, deploymentId: 'canvas-usage-test', signal: new AbortController().signal });
updateActorPolicy(db, { actorId: 'alice', monthlyLimitMinor: null, personalConcurrency: 5, paused: false, expectedVersion: 0 });
clearCanvasCapabilities();
const h3 = COMPANY_CANVAS_NATIVE_VIDEO_CAPABILITIES.find(capability => capability.modelAlias === 'minimax-h3')!;
for (const capability of [legacyFast, h3]) {
  db.prepare('INSERT INTO video_providers (id, name, type, baseUrl, defaultModel) VALUES (?, ?, ?, ?, ?)')
    .run(capability.providerIdentity, capability.displayName, 'openai-video', 'http://127.0.0.1:4000', capability.modelAlias);

}
upsertExecutionPool(db, {
  poolKey: legacyMediaProviderPoolKey('http://127.0.0.1:4000', 'fixture'), kind: 'remote', capacity: 5, enabled: true,
  mappingSnapshot: { protocol: 'legacy-media-upstream/1', baseUrl: 'http://127.0.0.1:4000',
    credentialFingerprint: legacyMediaProviderCredentialFingerprint('http://127.0.0.1:4000', 'fixture') }, expectedVersion: 0,
});
for (const capability of configuredCanvasVideos(db)) registerCanvasCapability(capability);
const fast = configuredCanvasVideos(db).find(capability => capability.modelAlias === legacyFast.modelAlias)!;
const failures: string[] = [];
async function check(name: string, test: () => Promise<void>) {
  try { await runWithAccessContext(access, test); console.log(`PASS: ${name}`); }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function taskFor(name: string, capability: CanvasModelCapability, parameters: Record<string, number>) {
  return runWithAccessContext(access, () => {
    const canvas = createCanvas(db, { name });
    saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: 0, graph: {
      schemaVersion: 1, edges: [], nodes: [{ id: name, kind: 'video-generation', position: { x: 0, y: 0 }, data: {
        title: name, modelKey: capability.key, generationMode: 'text-to-video', prompt: 'fixture',
        parameters, references: [], referenceLabelCounter: 0,
      } }],
    } });
    return startCanvasRun({ db, request: { canvasId: canvas.id, mode: 'single', targetNodeId: name, requestKey: name } }).tasks[0]!;
  });
}
function assertCost(taskId: string) {
  const ledger = db.prepare('SELECT costMicros FROM usage_ledger WHERE refType=? AND refId=?')
    .all('canvas-task', taskId) as { costMicros: number }[];
  assert.equal(ledger.length, 1, 'one generation must have exactly one ledger entry');
  const usage = queryTeamUsage(db, { userId: 'alice', role: 'employee' }).items.find(row => row.taskId === taskId)!;
  assert.equal(usage.costStatus, 'settled', 'completed video must stop showing uncertain / zero cost');
  assert.equal(usage.actualMinor, Math.ceil(ledger[0].costMicros / 10_000), 'team usage must include the measured canvas ledger cost');
}
try {
  const video = path.join(root, 'fixture.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=24', '-t', '5.088', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const bytes = fs.readFileSync(video);
  for (const behavior of ['success', 'cancelled', 'download-retry'] as const) {
    await check(`automatic duration / ${behavior}`, async () => {
      const task = taskFor(behavior, fast, { durationSec: -1 });
      const fixture = createCanvasFixtureAdapter({ defaultScript: { bytes, failFirstDownload: behavior === 'download-retry' } });
      const adapter = behavior !== 'cancelled' ? fixture : { ...fixture, async poll() {
        requestCanvasTaskCancel(db, { taskId: task.id });
        return { status: 'succeeded' as const };
      } };
      const run = () => runWithAccessContext(access, async () => {
        const [claimed] = claimCanvasTasks({ db, workerId: 'worker', limit: 1 });
        assert.equal(claimed?.task.id, task.id);
        return runCanvasTask({ db, taskId: task.id, workerId: 'worker', fence: claimed.fence,
          adapter, execution: { facade: runtime.facade, instance: identity }, storageRoot: path.join(root, 'storage'), pollIntervalMs: 0 });
      });
      await run();
      if (behavior === 'download-retry') {
        assert.equal(getCanvasTask(db, task.id)?.phase, 'download_failed');
        runWithAccessContext(access, () => retryCanvasTaskDownload(db, { taskId: task.id }));
        await run();
      }
      assert.equal(getCanvasTask(db, task.id)?.phase, behavior === 'cancelled' ? 'cancelled' : 'succeeded', JSON.stringify(getCanvasTask(db, task.id)));
      assert.equal(fixture.submissions.length, 1, 'late settlement / download retry must not resubmit generation');
      assertCost(task.id);
    });
  }
  await check('H3 uses the adapter default of five output seconds', async () => {
    const task = taskFor('h3-defaults', h3, {});
    const quote = canvasTaskCostQuote(db, task);
    assert.equal(quote.kind, 'priced', 'untouched default parameters must be priced before submit');
    if (quote.kind === 'priced') assert.equal(quote.reserve.minor, 400);
  });
  assert.equal(failures.length, 0, failures.join('\n'));
} finally {
  runtime.closeNewWork(); clearCanvasCapabilities(); db.close(); process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('creative-canvas-execution-usage.test.ts passed');