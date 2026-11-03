import crypto from 'node:crypto';
import fs from 'node:fs';
import { readRuntimeConfig } from './config.ts';
import type { TeamRuntimeState } from './runtime/state.ts';

interface OperationDependencies {
  getState: () => TeamRuntimeState;
  shutdown?: () => Promise<{ stopped: boolean; pendingTasks: number }>;
  scheduleExit?: () => void;
  pid?: number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function authorized(request: Request, deploymentId: string): boolean {
  const credentialPath = process.env.CREATIVE_STUDIO_CONTROL_CREDENTIAL_FILE;
  if (!credentialPath) return false;
  let credential: { schemaVersion?: number; deploymentId?: string; token?: string };
  try {
    const stat = fs.lstatSync(credentialPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    credential = JSON.parse(fs.readFileSync(credentialPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return false;
  }
  if (credential.schemaVersion !== 1 || credential.deploymentId !== deploymentId
    || typeof credential.token !== 'string' || credential.token.length < 32) return false;
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(credential.token);
  return supplied.length === expected.length && supplied.length > 0 && crypto.timingSafeEqual(supplied, expected);
}

export async function handleTeamOperation(
  request: Request,
  action: 'status' | 'shutdown',
  dependencies: OperationDependencies,
): Promise<Response> {
  let config: ReturnType<typeof readRuntimeConfig>;
  try { config = readRuntimeConfig(); } catch { return json({ error: 'not_found' }, 404); }
  if (config.mode !== 'server') return json({ error: 'not_found' }, 404);
  if (!authorized(request, config.deploymentId)) return json({ error: 'unauthorized' }, 401);
  const state = dependencies.getState();
  if (action === 'status') {
    return json({
      deploymentId: config.deploymentId,
      instanceId: state.instanceId,
      pid: dependencies.pid ?? process.pid,
      ready: state.ready,
      maintenance: state.maintenance,
      phase: state.phase,
      fence: state.fence,
    });
  }
  if (!dependencies.shutdown || !dependencies.scheduleExit) return json({ error: 'shutdown_unavailable' }, 503);
  let body: unknown;
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) return json({ error: 'invalid_request' }, 400);
    body = await request.json();
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || (body as { instanceId?: unknown }).instanceId !== state.instanceId
    || typeof state.instanceId !== 'string' || !state.instanceId) {
    return json({ error: 'instance_mismatch' }, 409);
  }
  const result = await dependencies.shutdown();
  dependencies.scheduleExit();
  return json({
    deploymentId: config.deploymentId,
    instanceId: state.instanceId,
    stopped: result.stopped,
    pendingTasks: result.pendingTasks,
  });
}
