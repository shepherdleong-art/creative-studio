// node scripts/unified-image-fallback.test.ts
// Real SQLite + execution facade + image queue; all HTTP is intercepted and unpriced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-image-fallback-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-image-fallback-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'unified-image-fallback-test-instance',
  CREATIVE_STUDIO_PORT: '43119',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { getDb, closeDb } = await import('../lib/db.ts');
const { startTeamServiceRuntime, drainTeamRuntime, releaseTeamRuntimeOwner } = await import('../lib/team-service/runtime/index.ts');
const queue = await import('../lib/queue.ts');
const { seedProviders } = await import('../lib/seed.ts');
const {
  configureLegacyMediaProviderPool,
  LegacyMediaNotCreatedError,
  legacyMediaExecutionRevision,
  submitLegacyMediaOperation,
} = await import('../lib/legacy-media-execution.ts');
const { providerHttpError } = await import('../lib/media-core/submission-evidence.ts');
const { readActorPolicy, updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { runWithTaskAccessContext } = await import('../lib/media-core/access-context.ts');
const { freezeUnifiedImageRequest } = await import('../lib/media-core/unified-media/requests.ts');
const {
  UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_CHANNELS, UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION,
} = await import('../lib/media-core/unified-media/catalog.ts');
const {
  listUnifiedImageChannelAttempts,
  prepareUnifiedImageExecution,
  requestUnifiedImageCancellation,
  UnifiedImageRecoveryPendingError,
} = await import('../lib/media-core/unified-media/execution.ts');
const { listTeamTasks } = await import('../lib/team-service/tasks.ts');
const { queryTeamUsage } = await import('../lib/team-service/usage.ts');
const { listTeamErrors, getTeamErrorDiagnostic } = await import('../lib/team-service/diagnostics.ts');

const originalFetch = globalThis.fetch;
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#eeeeee' } }).png().toBuffer();
const qiniuBase = 'https://qiniu.example.test';
const tencentBase = 'https://tencent.example.test';
const qiniuKey = 'fixture-qiniu-key';
const tencentKey = 'fixture-tencent-key';

interface RuleFixture {
  post: () => Response;
  poll?: () => Response;
  onPost?: () => void;
}

interface CaseFixture {
  qiniu?: RuleFixture;
  tencent?: RuleFixture;
  downloadStatuses?: number[];
}

const fixtures = new Map<string, CaseFixture>();
const requests: Array<{ channel: 'qiniu' | 'tencent'; method: string; prompt: string; model?: string }> = [];
const asyncFailedIds = new Set<string>();

function readPrompt(init?: RequestInit): string {
  if (typeof init?.body !== 'string') return '';
  try {
    const body = JSON.parse(init.body) as { prompt?: unknown };
    return typeof body.prompt === 'string' ? body.prompt : '';
  } catch {
    return '';
  }
}

function channelOf(url: string): 'qiniu' | 'tencent' | null {
  if (url.startsWith(qiniuBase)) return 'qiniu';
  if (url.startsWith(tencentBase)) return 'tencent';
  return null;
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function successResponse(channel: 'qiniu' | 'tencent', prompt: string): Response {
  return Response.json({
    id: `${channel}-${prompt}`,
    status: 'completed',
    metadata: { url: `${channel === 'qiniu' ? qiniuBase : tencentBase}/result/${encodeURIComponent(prompt)}.png` },
  });
}

globalThis.fetch = (async (input, init) => {
  const url = String(input);
  const method = String(init?.method || 'GET').toUpperCase();
  const channel = channelOf(url);
  const prompt = readPrompt(init);
  let model: string | undefined;
  if (channel && typeof init?.body === 'string') {
    try {
      const body = JSON.parse(init.body) as { model?: unknown };
      model = typeof body.model === 'string' ? body.model : undefined;
    } catch {
      // Downloads and poll requests do not carry JSON bodies.
    }
  }
  if (channel) requests.push({ channel, method, prompt, model });

  if (channel && method === 'POST' && url.endsWith('/v1/videos')) {
    const fixture = fixtures.get(prompt)?.[channel];
    if (!fixture) throw new Error(`missing ${channel} fixture for ${prompt}`);
    fixture.onPost?.();
    return fixture.post();
  }

  const taskMatch = /\/(qiniu|tencent)-([^/]+)$/.exec(new URL(url).pathname);
  if (channel && method === 'GET' && taskMatch && asyncFailedIds.has(`${taskMatch[1]}-${taskMatch[2]}`)) {
    return Response.json({
      id: `${taskMatch[1]}-${taskMatch[2]}`,
      status: 'failed',
      error: { message: 'provider terminal rejection' },
    });
  }
  if (channel && method === 'GET' && taskMatch) {
    const poll = fixtures.get(taskMatch[2])?.[channel]?.poll;
    if (poll) return poll();
  }

  const downloadMatch = /\/result\/(.+)\.png$/.exec(new URL(url).pathname);
  if (channel && method === 'GET' && downloadMatch) {
    const downloadPrompt = decodeURIComponent(downloadMatch[1]);
    const statuses = fixtures.get(downloadPrompt)?.downloadStatuses;
    const status = statuses && statuses.length > 0 ? statuses.shift()! : 200;
    if (status !== 200) return textResponse(status, 'fixture download failure');
    return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
  }

  throw new Error(`unexpected fixture request: ${method} ${url}`);
}) as typeof fetch;

function insertMemberAndProject(
  db: ReturnType<typeof getDb>,
  projectId: string,
): string {
  const now = new Date().toISOString();
  const imagePath = path.join(root, `${projectId}.png`);
  fs.writeFileSync(imagePath, png);
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, size, quality)
    VALUES (?, ?, ?, ?, 'prompt', '1728x2304', 'auto')`)
    .run(projectId, projectId, UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage)
    VALUES (?, ?, 'input', ?, ?, 'image/png', 'scene_seed')`)
    .run(`image-${projectId}`, projectId, `${projectId}.png`, imagePath);
  db.prepare(`INSERT INTO team_resource_scopes
    (resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt)
    VALUES ('project', ?, 'member', 'project', ?, ?, ?)`).run(projectId, projectId, now, now);
  return `image-${projectId}`;
}

function insertUnifiedJob(
  db: ReturnType<typeof getDb>,
  input: { id: string; projectId: string; inputImageId: string; prompt: string },
): void {
  const frozen = freezeUnifiedImageRequest({
    inputImageId: input.inputImageId,
    referenceImageIds: [],
    prompt: input.prompt,
    tier: '2k',
    ratio: '1:1',
    referenceGuidanceMode: 'none',
  });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (
      id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality,
      status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex,
      unifiedModel, unifiedRuleVersion, unifiedRequestJson
    ) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, 'auto', 'pending', 0, 1, 'none', ?, 0, ?, ?, ?)`)
    .run(
      input.id, input.projectId, input.inputImageId,
      UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY,
      frozen.prompt, frozen.size, now, UNIFIED_IMAGE_MODEL_KEY,
      UNIFIED_MEDIA_RULE_VERSION, JSON.stringify(frozen),
    );
  db.prepare(`INSERT INTO team_resource_scopes
    (resourceType, resourceId, ownerUserId, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES ('job', ?, 'member', 'project', ?, 'project', ?, ?, ?)`)
    .run(input.id, input.projectId, input.projectId, now, now);
  db.prepare(`INSERT INTO team_task_principals
    (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
    VALUES ('image', ?, 'member', 'project', ?, ?, ?)`)
    .run(input.id, input.projectId, JSON.stringify(frozen), now);
}

function createCase(
  db: ReturnType<typeof getDb>,
  name: string,
  fixture: CaseFixture,
): { projectId: string; jobId: string; prompt: string } {
  const projectId = `project-${name}`;
  const jobId = `job-${name}`;
  const prompt = `case-${name}`;
  fixtures.set(prompt, fixture);
  const imageId = insertMemberAndProject(db, projectId);
  insertUnifiedJob(db, { id: jobId, projectId, inputImageId: imageId, prompt });
  return { projectId, jobId, prompt };
}

function attachShot(db: ReturnType<typeof getDb>, projectId: string, jobId: string): void {
  const job = db.prepare('SELECT inputImageId FROM jobs WHERE id = ?').get(jobId) as { inputImageId: string };
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES (?, ?, 'fallback')`)
    .run(`shot-set-${jobId}`, projectId);
  db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, latestJobId)
    VALUES (?, ?, 0, ?, ?)`)
    .run(`shot-${jobId}`, `shot-set-${jobId}`, job.inputImageId, jobId);
}

function runJob(projectId: string, jobId: string): Promise<void> {
  return queue.runQueue({ projectId, jobId, concurrency: 4, maxAttempts: 5, timeoutMs: 30_000 });
}

function postCount(prompt: string, channel: 'qiniu' | 'tencent'): number {
  return requests.filter((item) => item.prompt === prompt && item.channel === channel && item.method === 'POST').length;
}

function tryLedger(jobId: string) {
  try {
    return listUnifiedImageChannelAttempts(getDb(), jobId);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function setPoolCapacity(channel: 'qiniu' | 'tencent', capacity: number): void {
  configureLegacyMediaProviderPool({
    baseUrl: channel === 'qiniu' ? qiniuBase : tencentBase,
    apiKey: channel === 'qiniu' ? qiniuKey : tencentKey,
    capacity,
  });
}

function setPolicy(db: ReturnType<typeof getDb>, input: {
  monthlyLimitMinor?: number | null;
  allowedModels?: string[] | null;
}): void {
  const current = readActorPolicy(db, 'member');
  updateActorPolicy(db, {
    actorId: 'member',
    monthlyLimitMinor: input.monthlyLimitMinor === undefined ? current.monthlyLimitMinor : input.monthlyLimitMinor,
    personalConcurrency: current.personalConcurrency,
    paused: false,
    expectedVersion: current.version,
    allowedModels: input.allowedModels === undefined ? current.allowedModels : input.allowedModels,
  });
}

try {
  const runtime = await startTeamServiceRuntime();
  assert.equal(runtime.ready, true, runtime.code);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES ('member', 'member', 'Member', 'employee', 'active', 'hash', ?, ?)`).run(now, now);
  updateActorPolicy(db, {
    actorId: 'member', monthlyLimitMinor: null, personalConcurrency: 10, paused: false, expectedVersion: 0,
  });
  seedProviders();
  db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?`)
    .run(qiniuBase, qiniuKey, UNIFIED_IMAGE_CHANNELS[0].providerId);
  db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?`)
    .run(tencentBase, tencentKey, UNIFIED_IMAGE_CHANNELS[1].providerId);
  configureLegacyMediaProviderPool({ baseUrl: qiniuBase, apiKey: qiniuKey, capacity: 4 });
  configureLegacyMediaProviderPool({ baseUrl: tencentBase, apiKey: tencentKey, capacity: 4 });

  {
    const testCase = createCase(db, 'qiniu-to-tencent', {
      qiniu: { post: () => textResponse(400, 'review rejected') },
      tencent: { post: () => successResponse('tencent', 'case-qiniu-to-tencent') },
    });
    attachShot(db, testCase.projectId, testCase.jobId);
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(testCase.prompt, 'qiniu'), 1);
    assert.equal(postCount(testCase.prompt, 'tencent'), 1);
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.actorId, 'member');
    assert.equal(ledger.scopeType, 'project');
    assert.equal(ledger.scopeId, testCase.projectId);
    assert.equal(ledger.sourceType, 'project_scene');
    assert.equal((ledger.result as Record<string, unknown>).channelKey, 'tencent');
    assert.equal(ledger.submissionCount, 2);
    assert.equal(ledger.usedChannelCount, 2);
    const qiniu = ledger.channels.find((channel) => channel.channelKey === 'qiniu')!;
    const tencent = ledger.channels.find((channel) => channel.channelKey === 'tencent')!;
    assert.equal(qiniu.state, 'not_created');
    assert.equal(tencent.state, 'succeeded');
    assert.equal(qiniu.attempts[0]?.reservedMinor, 25);
    assert.equal(qiniu.attempts[0]?.costState, 'released');
    assert.equal(qiniu.attempts[0]?.providerSnapshot.model, 'qiniuyun/gpt-image-2-medium');
    assert.equal(tencent.attempts[0]?.reservedMinor, 158);
    assert.equal(tencent.attempts[0]?.actualMinor, 158);
    assert.equal(tencent.attempts[0]?.costState, 'settled');
    assert.equal(tencent.attempts[0]?.providerSnapshot.model, 'image2-medium');
    assert.notEqual(qiniu.attempts[0]?.permitId, tencent.attempts[0]?.permitId);
    assert.notEqual(qiniu.attempts[0]?.operationId, tencent.attempts[0]?.operationId);
    assert.equal(qiniu.operationId, qiniu.attempts[0]?.operationId);
    assert.ok(qiniu.configVersion);
    assert.ok(qiniu.credentialVersionRef);
    assert.ok(qiniu.evidence);
    assert.equal(qiniu.evidence?.attemptId, qiniu.attempts[0]?.attemptId);
    const job = db.prepare('SELECT providerId, model, attempt, maxAttempts, outputImageId, estimatedCost, executionRevision FROM jobs WHERE id = ?')
      .get(testCase.jobId) as Record<string, unknown>;
    assert.equal(job.providerId, UNIFIED_IMAGE_ANCHOR_ID);
    assert.equal(job.model, UNIFIED_IMAGE_MODEL_KEY);
    assert.equal(job.attempt, 2);
    assert.equal(job.maxAttempts, 1, 'channel attempts must not be represented as legacy maxAttempts');
    assert.equal(job.executionRevision, 2);
    assert.ok(job.outputImageId);
    assert.equal(job.estimatedCost, 1.58);
    assert.equal(
      db.prepare("SELECT COUNT(*) FROM image_assets WHERE projectId = ? AND role = 'output'").pluck().get(testCase.projectId),
      1,
      'one logical success must register exactly one output',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM shot_result_candidates WHERE jobId = ?').pluck().get(testCase.jobId),
      1,
      'one logical success must advance the shot candidate exactly once',
    );
    const task = listTeamTasks(db, { userId: 'member', role: 'admin' }).items.find((item) => item.taskId === testCase.jobId);
    assert.equal(task?.unifiedModel, 'image2');
    const usage = queryTeamUsage(db, { userId: 'member', role: 'admin' }, { module: 'image' })
      .items.filter((item) => item.taskId === testCase.jobId);
    assert.equal(usage.length, 2);
    assert.equal(usage.find((item) => item.outcome === 'not_created')?.costStatus, 'released');
    assert.equal(usage.find((item) => item.outcome === 'succeeded')?.costStatus, 'settled');
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(postCount(testCase.prompt, 'qiniu') + postCount(testCase.prompt, 'tencent'), 2, 're-running must not submit again');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM shot_result_candidates WHERE jobId = ?').pluck().get(testCase.jobId),
      1,
      're-running a completed task must not duplicate the shot candidate',
    );
  }

  {
    const prompt = 'case-restart-after-not-created';
    const testCase = createCase(db, 'restart-after-not-created', {
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?')
      .get(UNIFIED_IMAGE_CHANNELS[0].providerId) as {
        id: string; type: string; baseUrl: string; apiKey: string;
      };
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(testCase.jobId);
    const prepared = runWithTaskAccessContext(db, 'image', testCase.jobId, () =>
      prepareUnifiedImageExecution(db, testCase.jobId, new Date(Date.now() + 2_000)));
    assert.equal(prepared.channel.channelKey, 'qiniu');

    let firstFailure: unknown;
    try {
      await runWithTaskAccessContext(db, 'image', testCase.jobId, () =>
        submitLegacyMediaOperation<never>({
          module: 'image',
          taskId: testCase.jobId,
          projectId: testCase.projectId,
          inputRevision: legacyMediaExecutionRevision(prepared.channel.executionRevision),
          inputSnapshot: { prompt },
          requestSnapshot: { model: UNIFIED_IMAGE_CHANNELS[0].model, prompt },
          providerSnapshot: {
            providerId: provider.id,
            type: provider.type,
            model: UNIFIED_IMAGE_CHANNELS[0].model,
            baseUrl: provider.baseUrl,
          },
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 25 }, pricingSnapshot: null },
          mediaTaskId: prepared.taskId,
          channelKey: prepared.channel.channelKey,
          send: async () => {
            throw providerHttpError(400, 'fixture rejected before restart');
          },
        }));
    } catch (error) {
      firstFailure = error;
    }
    assert.ok(firstFailure instanceof LegacyMediaNotCreatedError);
    const interruptedOperation = db.prepare(`
      SELECT status, currentAttemptId FROM execution_operations
      WHERE mediaTaskId = ? AND channelKey = 'qiniu'
    `).get(prepared.taskId) as { status: string; currentAttemptId: string | null };
    assert.equal(interruptedOperation.status, 'pending');

    assert.throws(
      () => runWithTaskAccessContext(db, 'image', testCase.jobId, () =>
        prepareUnifiedImageExecution(db, testCase.jobId)),
      (error: unknown) => error instanceof UnifiedImageRecoveryPendingError,
      'restart recovery must advance the persisted explicit failure instead of resubmitting qiniu',
    );
    const recoveredTask = db.prepare(`
      SELECT currentChannelKey, status FROM execution_media_tasks WHERE id = ?
    `).get(prepared.taskId) as { currentChannelKey: string; status: string };
    assert.deepEqual(recoveredTask, { currentChannelKey: 'tencent', status: 'routing' });
    assert.equal(
      db.prepare('SELECT executionRevision FROM jobs WHERE id = ?').pluck().get(testCase.jobId),
      2,
    );

    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(prompt, 'qiniu'), 0, 'the interrupted qiniu attempt must not be submitted again');
    assert.equal(postCount(prompt, 'tencent'), 1);
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'not_created');
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'tencent')?.state, 'succeeded');
    assert.equal(ledger.submissionCount, 2);
  }

  {
    const prompt = 'case-budget-blocked';
    const testCase = createCase(db, 'budget-blocked', {
      qiniu: {
        post: () => {
          setPolicy(db, { monthlyLimitMinor: 5 });
          return textResponse(400, 'qiniu rejected');
        },
      },
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    const running = runJob(testCase.projectId, testCase.jobId);
    await assert.rejects(
      runJob(testCase.projectId, testCase.jobId),
      /already running|already/,
      'a duplicate queue must not reset channel opportunities',
    );
    await waitFor(() => {
      const status = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId);
      const operation = db.prepare(`SELECT status, waitReason FROM execution_operations
        WHERE taskId = ? AND channelKey = 'tencent'`).get(testCase.jobId) as
        { status: string; waitReason: string | null } | undefined;
      return status === 'deferred' && operation?.waitReason === 'monthly_budget';
    }, 'backup budget gate');
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 0);
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.attempts[0]?.reservedMinor, 25);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'tencent')?.attempts.length, 0);
    await queue.drainImageQueues();
    await running;
    setPolicy(db, { monthlyLimitMinor: null });
  }

  {
    setPolicy(db, { monthlyLimitMinor: 100_000 });
    const prompt = 'case-cost-unknown-blocked';
    const testCase = createCase(db, 'cost-unknown-blocked', {
      qiniu: {
        post: () => {
          const id = `qiniu-${prompt}`;
          asyncFailedIds.add(id);
          return Response.json({ id, status: 'processing' });
        },
      },
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => {
      const status = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId);
      const operation = db.prepare(`SELECT status, waitReason FROM execution_operations
        WHERE taskId = ? AND channelKey = 'tencent'`).get(testCase.jobId) as
        { status: string; waitReason: string | null } | undefined;
      return status === 'deferred' && operation?.waitReason === 'cost_unknown';
    }, 'unknown-cost backup gate', 20_000);
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 0);
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    const qiniuAttempt = ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.attempts[0];
    assert.equal(qiniuAttempt?.costState, 'unknown');
    assert.equal(qiniuAttempt?.reservedMinor, 25);
    const held = db.prepare(`SELECT state, costState, reservedMinor FROM execution_reservations
      WHERE kind = 'cost' AND attemptId = ?`).get(qiniuAttempt!.attemptId) as
      { state: string; costState: string; reservedMinor: number };
    assert.deepEqual(held, { state: 'held', costState: 'unknown', reservedMinor: 25 });
    await queue.drainImageQueues();
    await running;
    setPolicy(db, { monthlyLimitMinor: null });
  }

  {
    const prompt = 'case-qiniu-remote-failed';
    let queryCalls = 0;
    const testCase = createCase(db, 'qiniu-remote-failed', {
      qiniu: {
        post: () => Response.json({ id: `qiniu-${prompt}`, status: 'processing' }),
        poll: () => {
          if (queryCalls++ === 0) throw new TypeError('fetch failed');
          return Response.json({ id: `qiniu-${prompt}`, status: 'failed', error: { message: 'provider terminal rejection' } });
        },
      },
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 1);
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    const qiniu = ledger.channels.find((channel) => channel.channelKey === 'qiniu')!;
    const tencent = ledger.channels.find((channel) => channel.channelKey === 'tencent')!;
    assert.equal(qiniu.state, 'failed');
    assert.equal(qiniu.attempts[0]?.remoteId, `qiniu-${prompt}`);
    assert.equal(qiniu.remoteId, `qiniu-${prompt}`);
    assert.equal(qiniu.attempts[0]?.terminalState, 'failed');
    assert.equal(qiniu.attempts[0]?.costState, 'unknown');
    assert.equal(tencent.state, 'succeeded');
    const viewer = { userId: 'member', role: 'employee' as const };
    const historicalErrors = listTeamErrors(db, viewer).items.filter((item) => item.taskId === testCase.jobId);
    assert.deepEqual(historicalErrors.map((item) => item.code).sort(), ['provider_failed', 'provider_poll_failed']);
    assert.ok(historicalErrors.every((item) => item.outcome === 'recovered'),
      '同一制作任务备用通道成功后，原通道的查询和生成故障都应显示已恢复');
    assert.equal(listTeamErrors(db, viewer, { actionableOnly: true }).items.some((item) => item.taskId === testCase.jobId), false);
    assert.equal(getTeamErrorDiagnostic(db, viewer, historicalErrors[0].errorId).outcome, 'recovered');
    assert.equal(
      db.prepare('SELECT estimatedCost FROM jobs WHERE id = ?').pluck().get(testCase.jobId),
      1.83,
      'the task estimate must add both real channel attempts, not multiply the winning price',
    );
  }

  {
    const prompt = 'case-failed-generation-history';
    const testCase = createCase(db, 'failed-generation-history', {
      qiniu: {
        post: () => {
          const id = `qiniu-${prompt}`;
          asyncFailedIds.add(id);
          return Response.json({ id, status: 'processing' });
        },
      },
      tencent: { post: () => textResponse(422, 'backup rejected') },
    });
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'failed');
    const oldParent = db.prepare('SELECT unifiedTaskId FROM jobs WHERE id = ?').pluck().get(testCase.jobId);
    const viewer = { userId: 'member', role: 'employee' as const };
    const failedError = listTeamErrors(db, viewer).items.find((item) => item.taskId === testCase.jobId && item.code === 'provider_failed');
    assert.ok(failedError);
    fixtures.set(prompt, { qiniu: { post: () => successResponse('qiniu', prompt) } });
    db.prepare(`UPDATE jobs SET status='pending', attempt=0, providerTaskId=NULL, providerStatus=NULL,
      remoteImageUrl=NULL, outputImageId=NULL, finishedAt=NULL, unifiedTaskId=NULL,
      unifiedGenerationId=NULL, cancelRequestedAt=NULL WHERE id=?`).run(testCase.jobId);
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.notEqual(db.prepare('SELECT unifiedTaskId FROM jobs WHERE id = ?').pluck().get(testCase.jobId), oldParent);
    assert.equal(getTeamErrorDiagnostic(db, viewer, failedError.errorId).outcome, 'final',
      '人工重开的生成轮次成功，不能冒充旧轮次通过备用通道自动恢复');
  }

  let qiniuProviderEnabled = true;
  {
    db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(UNIFIED_IMAGE_CHANNELS[0].providerId);
    qiniuProviderEnabled = false;
    const prompt = 'case-tencent-to-qiniu';
    const testCase = createCase(db, 'tencent-to-qiniu', {
      tencent: {
        post: () => {
          db.prepare('UPDATE providers SET enabled = 1 WHERE id = ?').run(UNIFIED_IMAGE_CHANNELS[0].providerId);
          qiniuProviderEnabled = true;
          return textResponse(400, 'tenant channel rejected');
        },
      },
      qiniu: { post: () => successResponse('qiniu', prompt) },
    });
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(qiniuProviderEnabled, true);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(prompt, 'tencent'), 1);
    assert.equal(postCount(prompt, 'qiniu'), 1);
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'succeeded');
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'tencent')?.state, 'not_created');
    assert.equal(ledger.submissionCount, 2);
  }

  {
    setPoolCapacity('tencent', 0);
    const prompt = 'case-capacity-wait';
    const testCase = createCase(db, 'capacity-wait', {
      qiniu: { post: () => textResponse(400, 'qiniu rejected') },
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => {
      const status = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId);
      const ledger = tryLedger(testCase.jobId);
      return status === 'deferred'
        && ledger?.channels.find((channel) => channel.channelKey === 'tencent')?.state === 'waiting_capacity';
    }, 'capacity-deferred fallback');
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 0, 'a capacity wait must not send the backup channel');
    let ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    const waitingTencent = ledger.channels.find((channel) => channel.channelKey === 'tencent')!;
    assert.equal(waitingTencent.attempts.length, 0, 'no POST means the backup channel opportunity is not consumed');
    assert.ok(waitingTencent.operationId);
    assert.equal(waitingTencent.operationWaitReason, 'pool_capacity');
    assert.equal(ledger.parentStatus, 'waiting');
    const waitingTask = listTeamTasks(db, { userId: 'member', role: 'admin' }).items
      .find((item) => item.taskId === testCase.jobId && item.waitReason === 'pool_capacity');
    assert.ok(waitingTask?.waitLabel.includes('等待可用资源'));
    const prepared = runWithTaskAccessContext(db, 'image', testCase.jobId, () =>
      prepareUnifiedImageExecution(db, testCase.jobId, new Date(Date.now() + 2_000)));
    assert.equal(prepared.channel.channelKey, 'tencent', 'restart must keep the waiting backup channel');
    assert.equal(prepared.channel.executionRevision, 2);
    setPoolCapacity('tencent', 1);
    await running;
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(prompt, 'tencent'), 1, 'the released backup channel must submit exactly once');
    ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.submissionCount, 2);
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(postCount(prompt, 'qiniu') + postCount(prompt, 'tencent'), 2);
  }

  {
    const prompt = 'case-unknown';
    const testCase = createCase(db, 'unknown', {
      qiniu: { post: () => textResponse(503, 'upstream unavailable') },
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    await runJob(testCase.projectId, testCase.jobId);
    const job = db.prepare('SELECT status, providerStatus FROM jobs WHERE id = ?').get(testCase.jobId) as
      { status: string; providerStatus: string };
    assert.deepEqual(job, { status: 'needs_check', providerStatus: 'unknown' });
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 0, 'unknown submission must not switch channels');
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'unknown');
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'tencent')?.state, 'candidate');
    assert.equal(ledger.submissionCount, 1);
  }

  {
    const prompt = 'case-poll-query-failed';
    let remoteRecovered = false;
    const testCase = createCase(db, 'poll-query-failed', {
      qiniu: {
        post: () => Response.json({ id: `qiniu-${prompt}`, status: 'processing' }),
        poll: () => {
          if (!remoteRecovered) throw new TypeError('fetch failed');
          return successResponse('qiniu', prompt);
        },
      },
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => {
      const row = db.prepare('SELECT status, providerTaskId FROM jobs WHERE id = ?').get(testCase.jobId) as
        { status: string; providerTaskId: string | null };
      return row.status === 'needs_check' && row.providerTaskId === `qiniu-${prompt}`;
    }, 'poll query failure needs_check');
    await queue.drainImageQueues();
    await running;
    const job = db.prepare('SELECT status, providerStatus, providerTaskId FROM jobs WHERE id = ?').get(testCase.jobId) as
      { status: string; providerStatus: string; providerTaskId: string | null };
    assert.equal(job.status, 'needs_check');
    assert.equal(job.providerStatus, 'needs_check');
    assert.equal(job.providerTaskId, `qiniu-${prompt}`);
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 0, 'a local poll query failure must keep the original channel');
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.submissionCount, 1);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'accepted');
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'tencent')?.state, 'candidate');

    const viewer = { userId: 'member', role: 'employee' as const };
    const queryError = listTeamErrors(db, viewer, { actionableOnly: true }).items.find(
      (item) => item.taskId === testCase.jobId && item.code === 'provider_poll_failed',
    );
    assert.ok(queryError, 'the real polling exception must be recorded against its original attempt');
    remoteRecovered = true;
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(db.prepare('SELECT errorMessage FROM jobs WHERE id = ?').pluck().get(testCase.jobId), null,
      'successful recovery must clear the old polling failure from the image job');
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 0, 'recovery must query the existing accepted task');
    assert.equal(listUnifiedImageChannelAttempts(db, testCase.jobId).submissionCount, 1);
    assert.equal(listTeamErrors(db, viewer, { errorId: queryError.errorId }).items[0]?.outcome, 'recovered',
      'a successful original attempt must recover its historical polling diagnostic');
    assert.equal(listTeamErrors(db, viewer, { actionableOnly: true, errorId: queryError.errorId }).items.length, 0,
      'the recovered query error must leave the actionable error list');
    assert.equal(getTeamErrorDiagnostic(db, viewer, queryError.errorId).outcome, 'recovered',
      'the retained diagnostic package must agree with the error list');
    assert.equal(db.prepare('SELECT outcome FROM team_error_records WHERE id = ?').pluck().get(queryError.errorId), 'final',
      'recovery must also work for historical final rows without rewriting their captured evidence');
  }

  {
    const prompt = 'case-download-refetch';
    let downloadCalls = 0;
    const testCase = createCase(db, 'download-refetch', {
      qiniu: { post: () => successResponse('qiniu', prompt) },
      tencent: { post: () => successResponse('tencent', prompt) },
      downloadStatuses: [500, 200],
    });
    await runJob(testCase.projectId, testCase.jobId);
    downloadCalls = requests.filter((item) => item.method === 'GET' && item.prompt === '').length;
    assert.ok(downloadCalls >= 2);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 0, 'download failure must refetch the original result, not fall back');
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.submissionCount, 1);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'succeeded');
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'tencent')?.state, 'candidate');
  }

  {
    const prompt = 'case-both-failed';
    const testCase = createCase(db, 'both-failed', {
      qiniu: { post: () => textResponse(400, 'qiniu rejected') },
      tencent: { post: () => textResponse(422, 'tencent rejected') },
    });
    await runJob(testCase.projectId, testCase.jobId);
    const job = db.prepare('SELECT status, errorMessage FROM jobs WHERE id = ?').get(testCase.jobId) as
      { status: string; errorMessage: string };
    assert.equal(job.status, 'failed');
    assert.match(job.errorMessage, /两条|通道/);
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 1);
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.submissionCount, 2);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'not_created');
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'tencent')?.state, 'not_created');
    assert.equal(ledger.parentStatus, 'failed');
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(postCount(prompt, 'qiniu') + postCount(prompt, 'tencent'), 2, 'two explicit failures must never become a third attempt');
  }

  {
    const prompt = 'case-permission-blocked';
    const testCase = createCase(db, 'permission-blocked', {
      qiniu: {
        post: () => {
          setPolicy(db, { allowedModels: ['image2-medium-only-forbidden'] });
          return textResponse(400, 'qiniu rejected');
        },
      },
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => {
      const status = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId);
      const operation = db.prepare(`SELECT status, waitReason FROM execution_operations
        WHERE taskId = ? AND channelKey = 'tencent'`).get(testCase.jobId) as
        { status: string; waitReason: string | null } | undefined;
      return status === 'deferred' && operation?.waitReason === 'model_forbidden';
    }, 'backup permission gate');
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 0);
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.attempts[0]?.reservedMinor, 25);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'tencent')?.attempts.length, 0);
    await queue.drainImageQueues();
    await running;
    setPolicy(db, { allowedModels: null });
  }

  {
    const prompt = 'case-cancel-race';
    const testCase = createCase(db, 'cancel-race', {
      qiniu: {
        post: () => {
          requestUnifiedImageCancellation(db, testCase.jobId);
          return textResponse(400, 'cancelled before fallback');
        },
      },
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'canceled');
    assert.equal(postCount(prompt, 'qiniu'), 1);
    assert.equal(postCount(prompt, 'tencent'), 0, 'a cancel observed with the first failure must stop the fallback');
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.submissionCount, 1);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'not_created');
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'tencent')?.attempts.length, 0);
  }

  {
    setPoolCapacity('tencent', 0);
    const prompt = 'case-cancel-waiting';
    const testCase = createCase(db, 'cancel-waiting', {
      qiniu: { post: () => textResponse(400, 'qiniu rejected') },
      tencent: { post: () => successResponse('tencent', prompt) },
    });
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => {
      const status = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId);
      const tencent = tryLedger(testCase.jobId)
        ?.channels.find((channel) => channel.channelKey === 'tencent');
      return status === 'deferred' && tencent?.state === 'waiting_capacity';
    }, 'cancel while backup is waiting');
    requestUnifiedImageCancellation(db, testCase.jobId);
    setPoolCapacity('tencent', 1);
    await running;
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'canceled');
    assert.equal(postCount(prompt, 'tencent'), 0, 'a persisted cancel intent must block the waiting backup submit');
    const ledger = listUnifiedImageChannelAttempts(db, testCase.jobId);
    assert.equal(ledger.submissionCount, 1);
    assert.equal(ledger.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'not_created');
  }

  {
    const prompt = 'case-cancel-after-accepted-late-result';
    const testCase = createCase(db, 'cancel-after-accepted-late-result', {
      qiniu: { post: () => successResponse('qiniu', prompt) },
    });
    attachShot(db, testCase.projectId, testCase.jobId);
    fixtures.get(prompt)!.qiniu!.onPost = () => {
      requestUnifiedImageCancellation(db, testCase.jobId);
    };
    await runJob(testCase.projectId, testCase.jobId);

    const job = db.prepare(`SELECT status, providerStatus, outputImageId, cancelRequestedAt
      FROM jobs WHERE id = ?`).get(testCase.jobId) as {
        status: string; providerStatus: string | null; outputImageId: string | null;
        cancelRequestedAt: string | null;
      };
    assert.equal(job.status, 'canceled');
    assert.equal(job.providerStatus, 'succeeded');
    assert.ok(job.cancelRequestedAt);
    assert.ok(job.outputImageId, 'late result is retained on the canceled task');
    assert.equal(
      db.prepare('SELECT latestGeneratedImageId FROM shots WHERE id = ?')
        .pluck().get(`shot-${testCase.jobId}`),
      null,
      'canceled late result must not advance the active shot',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM shot_result_candidates WHERE jobId = ?')
        .pluck().get(testCase.jobId),
      0,
      'canceled late result is saved on the task, not auto-promoted into downstream candidates',
    );
    const parent = db.prepare(`SELECT id, status, resultJson FROM execution_media_tasks
      WHERE module = 'image' AND taskId = ?`).get(testCase.jobId) as {
        id: string; status: string; resultJson: string;
      };
    assert.equal(parent.status, 'canceled');
    const result = JSON.parse(parent.resultJson) as Record<string, unknown>;
    assert.equal(result.lateResult, true);
    assert.equal(result.outputImageId, job.outputImageId);
    assert.equal(
      db.prepare(`SELECT state FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).pluck().get(parent.id),
      'succeeded',
      'the real channel attempt still records its successful terminal evidence',
    );
    assert.equal(postCount(prompt, 'qiniu'), 1, 'late result is downloaded without another model call');
    assert.equal(postCount(prompt, 'tencent'), 0);
  }

  console.log('unified image fallback tests passed (paid calls: 0)');
} finally {
  globalThis.fetch = originalFetch;
  await drainTeamRuntime(5_000);
  await releaseTeamRuntimeOwner();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
