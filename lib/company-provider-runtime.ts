import fs from 'node:fs';
import path from 'node:path';
import { isCosMediaConfigured } from './cos-media.ts';

export const COMPANY_PROVIDER_HEALTH_URL = 'http://127.0.0.1:4000/health/liveliness';
export const COMPANY_PROVIDER_HEALTH_TIMEOUT_MS = 1500;

export type CompanyProviderStatus = 'not_configured' | 'stopped' | 'unavailable' | 'ready';

export interface CompanyProviderRuntimeStatus {
  status: CompanyProviderStatus;
  reason: string;
  proxyAvailable: boolean;
  /** 参考图公网中转（腾讯云 COS）是否已配置；未配置时图片任务回退本机 URL。 */
  cosConfigured: boolean;
  startedAt: string | null;
}

export type CompanyProviderFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type CompanyProviderProcessCheck = (pid: number) => boolean;

export interface InspectCompanyProviderRuntimeOptions {
  /** Creative Studio project root; this is never returned in the status payload. */
  root: string;
  /** Injected in tests so inspection cannot accidentally reach a real service. */
  fetchImpl?: CompanyProviderFetch;
  /** Injected in tests; production only checks PIDs recorded by the controlled launcher. */
  processCheck?: CompanyProviderProcessCheck;
  timeoutMs?: number;
}

type StackState = {
  startedAt?: unknown;
  proxyPort?: unknown;
  litellmPid?: unknown;
};

function result(
  status: CompanyProviderStatus,
  reason: string,
  extras: Partial<Pick<CompanyProviderRuntimeStatus, 'proxyAvailable' | 'startedAt'>> = {},
): CompanyProviderRuntimeStatus {
  return {
    status,
    reason,
    proxyAvailable: extras.proxyAvailable ?? false,
    cosConfigured: isCosMediaConfigured(),
    startedAt: extras.startedAt ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStackState(stackFile: string): StackState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stackFile, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeStartedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  // The launcher writes an ISO-like local timestamp. Keep only that narrow shape;
  // never echo arbitrary stack-file content into the API response.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value) ? value : null;
}

function safeProxyPort(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : 4000;
}

function safePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function defaultProcessCheck(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasLiveProcess(
  processCheck: CompanyProviderProcessCheck,
  pid: number | null,
): boolean {
  if (pid === null) return false;
  try {
    return processCheck(pid);
  } catch {
    return false;
  }
}

async function isProxyReady(
  fetchImpl: CompanyProviderFetch,
  timeoutMs: number,
  proxyPort: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const healthUrl = proxyPort === 4000
      ? COMPANY_PROVIDER_HEALTH_URL
      : `http://127.0.0.1:${proxyPort}/health/liveliness`;
    const response = await fetchImpl(healthUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read-only company provider runtime inspection.
 *
 * This deliberately checks exactly one local LiteLLM liveliness URL. It does
 * not probe the company transit, Tencent, or any model endpoint, and it
 * never returns credentials or process IDs. Reference-image public delivery
 * (Tencent COS) is a per-request concern handled by the provider adapters,
 * not a persistent process this inspects — see `cosConfigured` on the result.
 */
export async function inspectCompanyProviderRuntime({
  root,
  fetchImpl = globalThis.fetch.bind(globalThis),
  processCheck = defaultProcessCheck,
  timeoutMs = COMPANY_PROVIDER_HEALTH_TIMEOUT_MS,
}: InspectCompanyProviderRuntimeOptions): Promise<CompanyProviderRuntimeStatus> {
  const configFile = path.join(root, 'config.yaml');
  const stackFile = path.join(root, 'storage', 'run', 'stack.json');

  if (!fs.existsSync(configFile)) {
    return result('not_configured', '尚未配置公司供应商');
  }

  if (!fs.existsSync(stackFile)) {
    return result('stopped', '公司供应商已配置但当前未启动');
  }

  const stack = readStackState(stackFile);
  if (!stack) {
    return result('unavailable', '公司供应商运行状态无效，请重新启动工作台');
  }

  const startedAt = safeStartedAt(stack.startedAt);
  const proxyPort = safeProxyPort(stack.proxyPort);
  const proxyProcessAvailable = hasLiveProcess(processCheck, safePid(stack.litellmPid));
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30_000) : COMPANY_PROVIDER_HEALTH_TIMEOUT_MS;
  const proxyAvailable = proxyProcessAvailable
    ? await isProxyReady(fetchImpl, timeout, proxyPort)
    : false;

  if (!proxyAvailable) {
    return result('unavailable', 'LiteLLM 本机健康检查失败', { proxyAvailable: false, startedAt });
  }

  return result('ready', 'LiteLLM 已就绪', { proxyAvailable: true, startedAt });
}
