import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from './data-root.ts';
import { isManagedDeployment } from './managed-deployment.ts';
import { isCosMediaConfigured } from './cos-media.ts';

export const COMPANY_PROVIDER_PROXY_PORT = 4000;
export const COMPANY_PROVIDER_HEALTH_URL = `http://127.0.0.1:${COMPANY_PROVIDER_PROXY_PORT}/health/liveliness`;
export const COMPANY_PROVIDER_HEALTH_TIMEOUT_MS = 1500;
export const COMPANY_PROVIDER_STATUS_FILE_NAME = 'company-sidecar-status.json';
export const COMPANY_PROVIDER_STATUS_SCHEMA_VERSION = 2 as const;

export type CompanyProviderStatus = 'not_configured' | 'stopped' | 'starting' | 'unavailable' | 'ready';

export type CompanyProviderStatusCode =
  | 'starting'
  | 'ready'
  | 'runtime_missing'
  | 'provision_invalid'
  | 'port_in_use'
  | 'process_exited'
  | 'health_timeout'
  | 'start_failed';

/** Safe, deliberately finite user-facing diagnostics. Never echo status-file text. */
export const COMPANY_PROVIDER_SAFE_REASONS: Readonly<Record<CompanyProviderStatusCode, string>> = {
  starting: '正在启动公司模型服务',
  ready: 'LiteLLM 已就绪',
  runtime_missing: '内置 LiteLLM 运行环境缺失，请重新安装',
  provision_invalid: '公司配置无效，请重新导入',
  port_in_use: 'LiteLLM 代理端口已被其他进程占用',
  process_exited: 'LiteLLM 进程已退出，请重试',
  health_timeout: 'LiteLLM 健康检查超时，请重试',
  start_failed: 'LiteLLM 启动失败，请重试',
};

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

/** The check receives the data root so the production implementation can validate ownership. */
export type CompanyProviderProcessCheck = (pid: number, root?: string) => boolean | Promise<boolean>;

/** A true result means that this PID owns a loopback listener on this port. */
export type CompanyProviderListenerCheckResult = boolean | { owned: boolean; inUse?: boolean };
export type CompanyProviderListenerCheck = (
  pid: number,
  port: number,
) => CompanyProviderListenerCheckResult | Promise<CompanyProviderListenerCheckResult>;

export interface InspectCompanyProviderRuntimeOptions {
  /** Creative Studio project/data root; this is never returned in the status payload. */
  root?: string;
  /** Injected in tests so inspection cannot accidentally reach a real service. */
  fetchImpl?: CompanyProviderFetch;
  /** Injected in tests; production only checks PIDs recorded by the controlled launcher. */
  processCheck?: CompanyProviderProcessCheck;
  /** Injected in tests; production verifies the listener owner using fixed local commands. */
  listenerCheck?: CompanyProviderListenerCheck;
  timeoutMs?: number;
  /** Require the bundled managed runtime and a published sidecar status file. */
  managed?: boolean;
}

interface StackState {
  startedAt?: unknown;
  proxyPort?: unknown;
  litellmPid?: unknown;
  sidecarKind?: unknown;
  runtimeRelativePath?: unknown;
  configRelativePath?: unknown;
  configHash?: unknown;
  provisionStateHash?: unknown;
}

interface SafeSidecarStatus {
  status: 'starting' | 'ready' | 'failed';
  code: CompanyProviderStatusCode;
}

export interface NetstatListenerRecord {
  localAddress: string;
  port: number;
  state: string;
  pid: number;
}

const MAX_STACK_FILE_BYTES = 128 * 1024;
const MAX_STATUS_FILE_BYTES = 16 * 1024;
const MAX_CONFIG_FILE_BYTES = 512 * 1024;
const MAX_PROVISION_STATE_FILE_BYTES = 128 * 1024;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONFIG_HASH = /^[a-f0-9]{64}$/i;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_STATUS_CODES = new Set<CompanyProviderStatusCode>([
  'starting',
  'ready',
  'runtime_missing',
  'provision_invalid',
  'port_in_use',
  'process_exited',
  'health_timeout',
  'start_failed',
]);

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

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function readUtf8Json(filePath: string, maxBytes: number): unknown | null {
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length <= 0 || bytes.length > maxBytes) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readStackState(stackFile: string): StackState | null {
  const parsed = readUtf8Json(stackFile, MAX_STACK_FILE_BYTES);
  return isRecord(parsed) ? parsed : null;
}

function readFileHash(filePath: string, maxBytes: number): string | null {
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length <= 0 || bytes.length > maxBytes) return null;
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

function readConfigHash(configFile: string): string | null {
  return readFileHash(configFile, MAX_CONFIG_FILE_BYTES);
}

function readProvisionStateHash(stateFile: string): string | null {
  return readFileHash(stateFile, MAX_PROVISION_STATE_FILE_BYTES);
}

function hasCurrentConfigHash(stack: StackState, configHash: string | null): boolean {
  return configHash !== null
    && typeof stack.configHash === 'string'
    && CONFIG_HASH.test(stack.configHash)
    && stack.configHash.toLowerCase() === configHash.toLowerCase();
}

function hasCurrentProvisionStateHash(stack: StackState, provisionStateHash: string | null): boolean {
  return provisionStateHash !== null
    && typeof stack.provisionStateHash === 'string'
    && CONFIG_HASH.test(stack.provisionStateHash)
    && stack.provisionStateHash.toLowerCase() === provisionStateHash.toLowerCase();
}

function safeStartedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  // The launcher writes a local timestamp. Keep only a narrow, non-secret shape.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value) ? value : null;
}

function safeProxyPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : null;
}

function safePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
    ? value
    : null;
}

function normalizedRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) return null;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.includes('..') || normalized.startsWith('/') || normalized.includes('\0')) return null;
  return normalized;
}

function isControlledStack(stack: StackState): boolean {
  return stack.sidecarKind === 'company-litellm'
    && normalizedRelativePath(stack.runtimeRelativePath) === 'runtime-litellm/python.exe'
    && normalizedRelativePath(stack.configRelativePath) === 'config.yaml';
}

function normalizeWindowsPath(value: string): string {
  const withoutNamespace = value.replace(/^\\\\\?\\/, '');
  return path.win32.normalize(withoutNamespace.replaceAll('/', '\\')).toLowerCase();
}

function processRecordString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key].length > 0) return record[key];
  }
  return null;
}

/** Tokenize the simple quoted command line emitted by Win32_Process.CommandLine. */
export function tokenizeWindowsCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|([^\s]+)/g;
  for (const match of commandLine.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? '');
  return tokens;
}

function commandPair(tokens: readonly string[], flag: string, expected: string, normalize = false): boolean {
  const normalizedFlag = flag.toLowerCase();
  const normalizedExpected = normalize ? normalizeWindowsPath(expected) : expected.toLowerCase();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const lower = token.toLowerCase();
    if (lower === normalizedFlag) {
      const next = tokens[index + 1] ?? '';
      const candidate = normalize ? normalizeWindowsPath(next) : next.toLowerCase();
      if (candidate === normalizedExpected) return true;
    }
    const prefix = `${normalizedFlag}=`;
    if (lower.startsWith(prefix)) {
      const candidate = token.slice(prefix.length);
      if ((normalize ? normalizeWindowsPath(candidate) : candidate.toLowerCase()) === normalizedExpected) return true;
    }
  }
  return false;
}

/** Pure ownership predicate used by the Windows process probe and its tests. */
export function isOwnedCompanyProviderProcessRecord(value: unknown, root: string): boolean {
  if (!isRecord(value)) return false;
  const executable = processRecordString(value, ['ExecutablePath', 'executablePath', 'executable']);
  const commandLine = processRecordString(value, ['CommandLine', 'commandLine']);
  if (!executable || !commandLine) return false;
  const expectedExecutable = path.join(root, 'runtime-litellm', 'python.exe');
  const expectedConfig = path.join(root, 'config.yaml');
  if (normalizeWindowsPath(executable) !== normalizeWindowsPath(expectedExecutable)) return false;
  const tokens = tokenizeWindowsCommandLine(commandLine);
  return commandPair(tokens, '-m', 'litellm.proxy.proxy_cli')
    && commandPair(tokens, '--config', expectedConfig, true)
    && commandPair(tokens, '--host', '127.0.0.1')
    && commandPair(tokens, '--port', String(COMPANY_PROVIDER_PROXY_PORT));
}

function defaultProcessCheck(pid: number, root = dataRoot()): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== 'win32') return false;
  try {
    const processIdLiteral = String(pid);
    const completed = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${processIdLiteral}' | Select-Object -First 1 ExecutablePath,CommandLine; if ($null -eq $p) { exit 1 }; $p | ConvertTo-Json -Compress`,
    ], {
      windowsHide: true,
      encoding: 'utf8',
      // PowerShell + CIM startup on a loaded machine exceeds 1.5 s, which
      // produced false process_exited reports for a healthy sidecar.
      timeout: 8000,
      maxBuffer: 128 * 1024,
    });
    if (completed.error || completed.status !== 0 || typeof completed.stdout !== 'string') return false;
    return isOwnedCompanyProviderProcessRecord(JSON.parse(completed.stdout) as unknown, root);
  } catch {
    return false;
  }
}

/** Parse one `netstat -ano -p tcp` row without trusting arbitrary output. */
export function parseNetstatListenerLine(line: string): NetstatListenerRecord | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 5 || fields[0]?.toUpperCase() !== 'TCP') return null;
  const endpoint = fields[1] ?? '';
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(endpoint);
  const plain = /^(.+):(\d+)$/.exec(endpoint);
  const localAddress = bracketed?.[1] ?? plain?.[1];
  const portText = bracketed?.[2] ?? plain?.[2];
  const port = portText ? Number(portText) : NaN;
  const pid = Number(fields[4]);
  if (!localAddress || !Number.isInteger(port) || port < 1 || port > 65_535 || !Number.isInteger(pid) || pid < 0) return null;
  return { localAddress, port, state: (fields[3] ?? '').toUpperCase(), pid };
}

function defaultUnmanagedProcessCheck(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read-only Windows listener ownership check using fixed command arguments. */
function defaultListenerCheck(pid: number, port: number): CompanyProviderListenerCheckResult {
  if (process.platform !== 'win32') return { owned: false, inUse: false };
  try {
    const completed = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 512 * 1024,
    });
    if (completed.error || completed.status !== 0 || typeof completed.stdout !== 'string') {
      return { owned: false, inUse: false };
    }
    let owned = false;
    let inUse = false;
    for (const line of completed.stdout.split(/\r?\n/)) {
      const record = parseNetstatListenerLine(line);
      if (!record || (record.state !== 'LISTENING' && record.state !== 'LISTEN') || record.port !== port) continue;
      if (record.localAddress === '127.0.0.1' && record.pid === pid) owned = true;
      else inUse = true;
    }
    return { owned, inUse };
  } catch {
    return { owned: false, inUse: false };
  }
}

function hasLiveProcess(processCheck: CompanyProviderProcessCheck, pid: number | null, root: string): Promise<boolean> {
  if (pid === null) return Promise.resolve(false);
  try {
    return Promise.resolve(processCheck(pid, root)).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function safeReasonForCode(code: CompanyProviderStatusCode): string {
  return COMPANY_PROVIDER_SAFE_REASONS[code];
}

function parseSafeSidecarStatus(value: unknown): SafeSidecarStatus | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'status', 'code', 'reason', 'updatedAt', 'requestId'])) return null;
  if (value.schemaVersion !== COMPANY_PROVIDER_STATUS_SCHEMA_VERSION) return null;
  if (typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) return null;
  if (value.status !== 'starting' && value.status !== 'ready' && value.status !== 'failed') return null;
  if (typeof value.code !== 'string' || !SAFE_STATUS_CODES.has(value.code as CompanyProviderStatusCode)) return null;
  const code = value.code as CompanyProviderStatusCode;
  if (value.status === 'starting' && code !== 'starting') return null;
  if (value.status === 'ready' && code !== 'ready') return null;
  if (value.status === 'failed' && (code === 'starting' || code === 'ready')) return null;
  // Accept only canonical reason labels (or the code itself for older launchers).
  if (typeof value.reason !== 'string'
    || (value.reason !== safeReasonForCode(code) && value.reason !== code)) return null;
  if (typeof value.updatedAt !== 'string' || !UTC_TIMESTAMP.test(value.updatedAt)) return null;
  const parsedDate = new Date(value.updatedAt);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString() !== value.updatedAt) return null;
  return { status: value.status, code };
}

function readSidecarStatus(statusFile: string): SafeSidecarStatus | null | 'missing' {
  if (!fs.existsSync(statusFile)) return 'missing';
  return parseSafeSidecarStatus(readUtf8Json(statusFile, MAX_STATUS_FILE_BYTES));
}

async function isProxyReady(
  fetchImpl: CompanyProviderFetch,
  timeoutMs: number,
  proxyPort: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const healthUrl = proxyPort === COMPANY_PROVIDER_PROXY_PORT
      ? COMPANY_PROVIDER_HEALTH_URL
      : `http://127.0.0.1:${proxyPort}/health/liveliness`;
    const response = await fetchImpl(healthUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function checkListener(
  listenerCheck: CompanyProviderListenerCheck,
  pid: number,
  port: number,
): Promise<CompanyProviderListenerCheckResult> {
  try {
    return await listenerCheck(pid, port);
  } catch {
    return false;
  }
}

function listenerIsOwned(listener: CompanyProviderListenerCheckResult): boolean {
  return typeof listener === 'boolean' ? listener : listener.owned && listener.inUse !== true;
}

function listenerIsInUse(listener: CompanyProviderListenerCheckResult): boolean {
  return typeof listener === 'object' && listener.inUse === true;
}

function unavailableForListener(
  listener: CompanyProviderListenerCheckResult,
  startedAt: string | null,
): CompanyProviderRuntimeStatus {
  return result('unavailable', safeReasonForCode(listenerIsInUse(listener) ? 'port_in_use' : 'start_failed'), { startedAt });
}

/** Read-only company provider runtime inspection; no upstream model probes. */
export async function inspectCompanyProviderRuntime({
  root = dataRoot(),
  fetchImpl = globalThis.fetch.bind(globalThis),
  processCheck,
  listenerCheck,
  timeoutMs = COMPANY_PROVIDER_HEALTH_TIMEOUT_MS,
  managed = isManagedDeployment(),
}: InspectCompanyProviderRuntimeOptions = {}): Promise<CompanyProviderRuntimeStatus> {
  const configFile = path.join(root, 'config.yaml');
  const provisioningStateFile = path.join(root, 'data', 'provisioning', 'state.json');
  const stackFile = path.join(root, 'storage', 'run', 'stack.json');
  const sidecarStatusFile = path.join(root, 'storage', 'run', COMPANY_PROVIDER_STATUS_FILE_NAME);
  const sidecarStartScript = path.join(root, 'scripts', 'start-company-sidecar.ps1');

  if (!fs.existsSync(configFile)) {
    return result('not_configured', safeReasonForCode('provision_invalid'));
  }

  if (managed && !fs.existsSync(path.join(root, 'runtime-litellm', 'python.exe'))) {
    return result('unavailable', safeReasonForCode('runtime_missing'));
  }

  if (managed && !fs.existsSync(sidecarStartScript)) {
    return result('unavailable', safeReasonForCode('start_failed'));
  }

  const effectiveProcessCheck = processCheck ?? (managed ? defaultProcessCheck : defaultUnmanagedProcessCheck);
  const effectiveListenerCheck = listenerCheck ?? (managed ? defaultListenerCheck : (() => true));

  // A managed status file is authoritative only for a managed deployment. A
  // developer-mode run may retain a stale file from an earlier managed run.
  const publishedStatus = managed ? readSidecarStatus(sidecarStatusFile) : 'missing';
  if (publishedStatus === null) {
    return result('unavailable', safeReasonForCode('provision_invalid'));
  }
  if (publishedStatus !== 'missing') {
    if (publishedStatus.status === 'starting') {
      return result('starting', safeReasonForCode('starting'));
    }
    if (publishedStatus.status === 'failed') {
      return result('unavailable', safeReasonForCode(publishedStatus.code));
    }
  }

  const hasStack = fs.existsSync(stackFile);
  if (publishedStatus === 'missing' && managed && !hasStack) {
    // A valid provision may briefly precede the launcher's first stack/status publication.
    return result('starting', safeReasonForCode('starting'));
  }

  if (!hasStack) {
    return managed
      ? result('unavailable', safeReasonForCode('provision_invalid'))
      : result('stopped', safeReasonForCode('process_exited'));
  }
  const stack = readStackState(stackFile);
  if (!stack || (managed && !isControlledStack(stack))) {
    return result('unavailable', safeReasonForCode('provision_invalid'));
  }

  if (managed && !hasCurrentConfigHash(stack, readConfigHash(configFile))) {
    return result('unavailable', safeReasonForCode('provision_invalid'));
  }
  if (managed && !hasCurrentProvisionStateHash(stack, readProvisionStateHash(provisioningStateFile))) {
    return result('unavailable', safeReasonForCode('provision_invalid'));
  }

  const startedAt = safeStartedAt(stack.startedAt);
  const proxyPort = safeProxyPort(stack.proxyPort) ?? (managed ? null : COMPANY_PROVIDER_PROXY_PORT);
  const pid = safePid(stack.litellmPid);
  if (proxyPort === null || (managed && proxyPort !== COMPANY_PROVIDER_PROXY_PORT)) {
    return result('unavailable', safeReasonForCode('port_in_use'), { startedAt });
  }
  if (pid === null || !(await hasLiveProcess(effectiveProcessCheck, pid, root))) {
    return result('unavailable', safeReasonForCode('process_exited'), { startedAt });
  }

  const listener = await checkListener(effectiveListenerCheck, pid, proxyPort);
  if (!listenerIsOwned(listener)) return unavailableForListener(listener, startedAt);

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 30_000)
    : COMPANY_PROVIDER_HEALTH_TIMEOUT_MS;
  const proxyAvailable = await isProxyReady(fetchImpl, timeout, proxyPort);
  if (!proxyAvailable) {
    return result('unavailable', safeReasonForCode('health_timeout'), { startedAt });
  }

  // Health can race with process exit or a port handoff. Revalidate both facts
  // after the 200 response and always run both checks before declaring ready.
  const finalProcessAlive = await hasLiveProcess(effectiveProcessCheck, pid, root);
  const finalListener = await checkListener(effectiveListenerCheck, pid, proxyPort);
  if (!finalProcessAlive) {
    return result('unavailable', safeReasonForCode('process_exited'), { startedAt });
  }
  if (!listenerIsOwned(finalListener)) return unavailableForListener(finalListener, startedAt);

  return result('ready', safeReasonForCode('ready'), { proxyAvailable: true, startedAt });
}
