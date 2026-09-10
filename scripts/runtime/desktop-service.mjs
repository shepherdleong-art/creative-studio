// scripts/runtime/desktop-service.mjs
// 桌面版私有服务的 electron-service.json 校验与停机链共享工具。
// 行为语义对齐：
// - desktop/service-state.ts（状态文件结构）、desktop/service-ready.ts（health instanceId 核身）、
//   desktop/service-shutdown.ts（优雅停机链：POST /api/shutdown → 轮询 → 归属校验后强杀）
// - installer/windows/stop-installed.ps1:21-52 与 stop-desktop.command:28-61
//   （origin 正则严格校验 127.0.0.1 + instanceId 格式 + health 核身，fail-closed）
// 红线：origin 不合法绝不请求；instance 不匹配绝不杀进程；归属不明只报告。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isOwnedByRoot, killTree } from './process-tree.mjs';

const SERVICE_FILENAME = 'electron-service.json';
/** 只接受本机回环地址的严格 origin：端口 1-65535，无路径、无主机名、无 IPv6。 */
const ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
/** 健康接口单次探测超时：与 service.ts 的 min(2000, healthTimeout) 一致。 */
const HEALTH_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 500;
const DEFAULT_SHUTDOWN_BUDGET_MS = 15_000;
const DEFAULT_POLL_TIMEOUT_MS = 20_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * origin 正则严格校验：形如 http://127.0.0.1:<port>，只接受 127.0.0.1。
 * 非法返回 null（调用方绝不向该 origin 发任何请求）。
 */
export function validateOrigin(rawOrigin) {
  if (typeof rawOrigin !== 'string') return null;
  const match = ORIGIN_PATTERN.exec(rawOrigin);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}`;
}

function toNullableInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 读取 electron-service.json。
 * 返回：
 *   { found: true, version, origin, instanceId, pid|null }
 *   { found: false, reason: 'no-state' | 'invalid-origin' | 'unreadable' }
 * origin 不合法（解析失败也归此类：状态文件无法用于核身）→ invalid-origin。
 */
export function readServiceState(rootDir) {
  const filePath = path.join(rootDir, 'storage', 'run', SERVICE_FILENAME);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { found: false, reason: 'no-state' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    console.warn(`[desktop-service] 无法解析 ${filePath}，按不可用状态处理`);
    return { found: false, reason: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { found: false, reason: 'unreadable' };
  }
  const origin = validateOrigin(parsed.origin);
  if (!origin) {
    return { found: false, reason: 'invalid-origin', rawOrigin: String(parsed.origin ?? '') };
  }
  const instanceId = typeof parsed.instanceId === 'string' ? parsed.instanceId : '';
  // instanceId 格式与参考实现一致（stop-installed.ps1 / stop-desktop.command），
  // 格式异常意味着状态文件无法用于核身，按不可用处理（绝不请求、绝不杀进程）。
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    return { found: false, reason: 'unreadable' };
  }
  const version = Number(parsed.version);
  return {
    found: true,
    version: Number.isInteger(version) ? version : 1,
    origin,
    instanceId,
    pid: toNullableInt(parsed.pid),
  };
}

/**
 * 健康核身：GET ${origin}/api/desktop/health，返回 body.instanceId。
 * 超时/非 200/响应非 JSON/instanceId 非字符串一律返回 null（核身失败 = 不匹配）。
 */
export async function fetchHealthInstance(origin, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const response = await fetch(`${origin}/api/desktop/health`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload && typeof payload === 'object' && typeof payload.instanceId === 'string') {
      return payload.instanceId;
    }
    return null;
  } catch {
    return null;
  }
}

async function requestShutdown(origin, timeoutMs) {
  try {
    await fetch(`${origin}/api/shutdown`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // /api/shutdown 会结束自己的进程，响应缺失或连接中断是预期行为。
  }
}

/**
 * 完整停机链：
 *   读状态 → origin 校验（invalid-origin 绝不请求）→ health 核身 instanceId
 *   （不匹配绝不杀进程）→ POST /api/shutdown → 轮询 health 直到下线（最长 pollTimeoutMs）
 *   → 仍在线且 pid 归属 rootDir 才 killTree；归属不明只报告（unknown-owner）。
 *
 * 返回 { stopped, reason, origin?, instanceId?, pid? }：
 *   reason: 'no-state' | 'invalid-origin' | 'unreadable' | 'instance-mismatch'
 *         | 'stopped' | 'killed' | 'unknown-owner'
 */
export async function stopDesktopService(
  rootDir,
  { shutdownBudgetMs = DEFAULT_SHUTDOWN_BUDGET_MS, pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS } = {},
) {
  const state = readServiceState(rootDir);
  if (!state.found) {
    return { stopped: false, reason: state.reason };
  }

  const expected = state.instanceId;
  const healthInstanceId = await fetchHealthInstance(state.origin);
  if (healthInstanceId !== expected) {
    // 状态文件记录的 origin 上找不到对应实例：绝不请求、绝不杀进程。
    return {
      stopped: false,
      reason: 'instance-mismatch',
      origin: state.origin,
      expectedInstanceId: expected,
      healthInstanceId,
    };
  }

  await requestShutdown(state.origin, shutdownBudgetMs);

  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    const current = await fetchHealthInstance(state.origin);
    if (current !== expected) {
      // 实例已下线（健康接口无响应、连接被拒，或端口被其他实例接管一律视为下线）。
      return { stopped: true, reason: 'stopped', origin: state.origin, instanceId: expected };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // 优雅停机超时：只有状态文件中的 pid 确属 rootDir 才强杀，归属不明只报告。
  if (state.pid && (await isOwnedByRoot(state.pid, rootDir))) {
    await killTree(state.pid);
    return { stopped: true, reason: 'killed', origin: state.origin, instanceId: expected, pid: state.pid };
  }
  return {
    stopped: false,
    reason: 'unknown-owner',
    origin: state.origin,
    instanceId: expected,
    pid: state.pid,
  };
}

function usage() {
  process.stderr.write('用法:\n  node scripts/runtime/desktop-service.mjs stop --root <dataRoot>\n');
}

/**
 * CLI 退出码：正常停止或本来就无记录=0；instance 不匹配/未知属主=2（报告但不动手）；
 * 其他错误（状态文件损坏、origin 非法等）=1。
 */
function exitCodeFor(reason) {
  switch (reason) {
    case 'no-state':
    case 'stopped':
    case 'killed':
      return 0;
    case 'instance-mismatch':
    case 'unknown-owner':
      return 2;
    default:
      return 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rootIndex = args.indexOf('--root');
  const rootDir = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  if (command !== 'stop' || !rootDir) {
    usage();
    process.exit(2);
  }
  const result = await stopDesktopService(rootDir);
  // stdout 逐行 key=value 进度，供脚本/用户跟踪。
  process.stdout.write(`state=${result.reason === 'no-state' ? 'none' : 'found'}\n`);
  if (result.origin) process.stdout.write(`origin=${result.origin}\n`);
  if (result.expectedInstanceId !== undefined || result.instanceId !== undefined) {
    process.stdout.write(`instance=${result.reason === 'instance-mismatch' ? 'mismatch' : 'match'}\n`);
  }
  switch (result.reason) {
    case 'no-state':
      break;
    case 'stopped':
      process.stdout.write('action=shutdown-requested\naction=stopped\n');
      break;
    case 'killed':
      process.stdout.write('action=shutdown-requested\naction=poll-timeout\naction=killed\n');
      break;
    case 'instance-mismatch':
    case 'unknown-owner':
      process.stdout.write('action=reported-only\n');
      break;
    default:
      process.stdout.write('action=reported-only\n');
  }
  process.exit(exitCodeFor(result.reason));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[desktop-service] ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
