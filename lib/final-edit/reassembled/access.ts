import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dataRoot } from '../../data-root.ts';
import { FinalEditError } from '../errors.ts';

export function desktopFilmIdentity() {
  const instanceId = process.env.CREATIVE_STUDIO_INSTANCE_ID;
  if (!instanceId || process.env.CREATIVE_STUDIO_DESKTOP !== '1') throw new FinalEditError('desktop_required', '请启动源码桌面版或免安装桌面版后重试', 503);
  const root = fs.realpathSync(dataRoot());
  const state = JSON.parse(fs.readFileSync(path.join(root, 'storage/run/electron-service.json'), 'utf8')) as { instanceId: string; origin: string };
  const url = new URL(state.origin);
  if (state.instanceId !== instanceId || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.origin !== state.origin) throw new FinalEditError('desktop_instance_mismatch', '桌面服务身份不匹配', 409);
  return { instanceId, origin: state.origin, dataIdentity: createHash('sha256').update(root).digest('hex'), apiVersion: 1 as const };
}
export function checkLocalRequest(request: Request, allowNavigation = false) {
  const identity = desktopFilmIdentity();
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  // Standalone Next reconstructs request.url with localhost; compare the actual
  // browser-facing Host against the exact persisted loopback origin instead.
  const host = request.headers.get('host') ?? url.host;
  if (url.protocol !== 'http:' || host !== new URL(identity.origin).host || (!allowNavigation && ((origin && origin !== identity.origin) || site === 'cross-site'))) throw new FinalEditError('film_origin_denied', '仅允许本机工作台访问', 403);
  return identity;
}
export function agentToken(): string {
  const file = path.join(dataRoot(), 'storage/run/reassembled-agent-token');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (!fs.existsSync(file)) throw error; }
  }
  return fs.readFileSync(file, 'utf8').trim();
}
export function assertAgentRequest(request: Request) {
  const identity = checkLocalRequest(request);
  const provided = Buffer.from(request.headers.get('x-reassembled-token') || '');
  const expected = Buffer.from(agentToken());
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected) ||
    request.headers.get('x-desktop-instance') !== identity.instanceId || request.headers.get('x-data-identity') !== identity.dataIdentity) throw new FinalEditError('film_agent_identity', 'Agent 连接已过期或不属于该数据目录，请重新发现桌面实例', 403);
  return identity;
}

export function filmWriteActor(request: Request): 'human' | 'agent' {
  const identity = checkLocalRequest(request);
  if (request.headers.has('x-reassembled-token')) {
    assertAgentRequest(request);
    return 'agent';
  }
  if (request.headers.get('origin') !== identity.origin || request.headers.get('sec-fetch-site') !== 'same-origin') {
    throw new FinalEditError('film_actor_required', '请从工作台操作；Agent 请使用实例身份与 token', 403);
  }
  return 'human';
}
