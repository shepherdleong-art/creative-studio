import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from './data-root.ts';
import { COMPANY_PROVIDER_SAFE_REASONS, COMPANY_PROVIDER_STATUS_FILE_NAME, COMPANY_PROVIDER_STATUS_SCHEMA_VERSION } from './company-provider-runtime.ts';

export type CompanySidecarAction = 'start' | 'restart';

export class CompanySidecarControlError extends Error {
  readonly code: 'invalid_action' | 'start_failed';

  constructor(code: 'invalid_action' | 'start_failed') {
    super(code === 'invalid_action' ? '不支持的公司模型服务操作' : '公司模型服务启动失败，请稍后重试');
    this.name = 'CompanySidecarControlError';
    this.code = code;
  }
}

export interface CompanySidecarRequestResult {
  accepted: true;
  action: CompanySidecarAction;
}

type CompanySidecarChild = Pick<ChildProcess, 'unref'> & Partial<Pick<ChildProcess, 'on' | 'once' | 'removeListener'>>;

export type CompanySidecarSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions & { windowsHide: boolean },
) => CompanySidecarChild | null;

export interface CompanySidecarRequestOptions {
  /** Test-only root; production always uses dataRoot(). */
  root?: string;
  /** Test-only spawn injection. No real PowerShell is used by unit tests. */
  spawnImpl?: CompanySidecarSpawn;
}

interface SidecarRequestContext {
  root: string;
  rootKey: string;
  token: number;
  requestId: string;
  startedAtMs: number;
  startingUpdatedAtMs: number | null;
  startingBytes: Buffer | null;
}

interface NarrowSidecarStatus {
  schemaVersion: typeof COMPANY_PROVIDER_STATUS_SCHEMA_VERSION;
  requestId: string;
  status: 'starting' | 'ready' | 'failed';
  code: keyof typeof COMPANY_PROVIDER_SAFE_REASONS;
  reason: string;
  updatedAt: string;
}

interface AtomicStatusPublication {
  updatedAtMs: number;
  bytes: Buffer;
}

const MAX_STATUS_FILE_BYTES = 16 * 1024;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const inFlight = new Map<CompanySidecarAction, Promise<CompanySidecarRequestResult>>();
const latestRequestTokenByRoot = new Map<string, number>();
let nextRequestToken = 0;
let nextStatusTempToken = 0;

function isAction(value: unknown): value is CompanySidecarAction {
  return value === 'start' || value === 'restart';
}

function scriptPath(root: string, action: CompanySidecarAction): string {
  // The installer copies these files into the app-root scripts directory. Do
  // not accept a caller-supplied path or provider configuration here.
  return path.join(root, 'scripts', `${action}-company-sidecar.ps1`);
}

function rootKey(root: string): string {
  try {
    return path.resolve(root).toLowerCase();
  } catch {
    return root.toLowerCase();
  }
}

function beginRequest(options: CompanySidecarRequestOptions): SidecarRequestContext {
  const root = options.root || dataRoot();
  const context: SidecarRequestContext = {
    root,
    rootKey: rootKey(root),
    token: ++nextRequestToken,
    requestId: randomUUID(),
    startedAtMs: Date.now(),
    startingUpdatedAtMs: null,
    startingBytes: null,
  };
  latestRequestTokenByRoot.set(context.rootKey, context.token);
  return context;
}

function isCurrentRequest(context: SidecarRequestContext): boolean {
  return latestRequestTokenByRoot.get(context.rootKey) === context.token;
}

function statusFilePath(root: string): string {
  return path.join(root, 'storage', 'run', COMPANY_PROVIDER_STATUS_FILE_NAME);
}

function parseNarrowStatus(value: unknown): NarrowSidecarStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedKeys = ['schemaVersion', 'requestId', 'status', 'code', 'reason', 'updatedAt'];
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) return null;
  if (record.schemaVersion !== COMPANY_PROVIDER_STATUS_SCHEMA_VERSION) return null;
  if (typeof record.requestId !== 'string' || !REQUEST_ID.test(record.requestId)) return null;
  if (record.status !== 'starting' && record.status !== 'ready' && record.status !== 'failed') return null;
  if (typeof record.code !== 'string' || !Object.hasOwn(COMPANY_PROVIDER_SAFE_REASONS, record.code)) return null;
  const code = record.code as keyof typeof COMPANY_PROVIDER_SAFE_REASONS;
  if ((record.status === 'starting' && code !== 'starting') || (record.status === 'ready' && code !== 'ready')
    || (record.status === 'failed' && (code === 'starting' || code === 'ready'))) return null;
  if (record.reason !== COMPANY_PROVIDER_SAFE_REASONS[code] && record.reason !== code) return null;
  if (typeof record.updatedAt !== 'string' || !UTC_TIMESTAMP.test(record.updatedAt)) return null;
  const parsed = new Date(record.updatedAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== record.updatedAt) return null;
  return record as unknown as NarrowSidecarStatus;
}

function readStatusBytes(filePath: string): Buffer | null {
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length <= 0 || bytes.length > MAX_STATUS_FILE_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

function parseNarrowStatusBytes(bytes: Buffer): NarrowSidecarStatus | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseNarrowStatus(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function shouldPublishStarting(context: SidecarRequestContext): boolean {
  return isCurrentRequest(context);
}

function shouldPublishFailure(context: SidecarRequestContext, filePath: string): boolean {
  if (!isCurrentRequest(context)) return false;
  const currentBytes = readStatusBytes(filePath);
  const current = currentBytes ? parseNarrowStatusBytes(currentBytes) : null;
  if (!current) return true;
  const currentUpdatedAt = new Date(current.updatedAt).getTime();
  if (context.startingUpdatedAtMs !== null
    && context.startingBytes !== null
    && current.status === 'starting'
    && current.code === 'starting'
    && current.requestId === context.requestId
    && current.reason === COMPANY_PROVIDER_SAFE_REASONS.starting
    && currentUpdatedAt === context.startingUpdatedAtMs
    && currentBytes !== null
    && currentBytes.equals(context.startingBytes)) return true;
  return currentUpdatedAt < context.startedAtMs;
}

function publishAtomicStatus(
  context: SidecarRequestContext,
  status: NarrowSidecarStatus['status'],
  code: keyof typeof COMPANY_PROVIDER_SAFE_REASONS,
  canPublish: (filePath: string) => boolean,
): AtomicStatusPublication | null {
  const filePath = statusFilePath(context.root);
  let tempPath: string | null = null;
  let descriptor = -1;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!canPublish(filePath)) return null;

    const updatedAt = new Date().toISOString();
    const statusRecord: NarrowSidecarStatus = {
      schemaVersion: COMPANY_PROVIDER_STATUS_SCHEMA_VERSION,
      requestId: context.requestId,
      status,
      code,
      reason: COMPANY_PROVIDER_SAFE_REASONS[code],
      updatedAt,
    };
    const bytes = Buffer.from(`${JSON.stringify(statusRecord)}\n`, 'utf8');
    tempPath = `${filePath}.${process.pid}.${context.token}.${++nextStatusTempToken}.tmp`;
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    try { fs.closeSync(descriptor); } finally { descriptor = -1; }

    // Recheck both ownership and freshness immediately before the atomic publish.
    if (!canPublish(filePath)) return null;
    fs.renameSync(tempPath, filePath);
    tempPath = null;
    return { updatedAtMs: new Date(updatedAt).getTime(), bytes };
  } catch {
    // Status publication is best effort; never leak a filesystem diagnostic.
    return null;
  } finally {
    if (descriptor !== -1) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    }
  }
}

function publishStarting(context: SidecarRequestContext): void {
  const publication = publishAtomicStatus(context, 'starting', 'starting', () => shouldPublishStarting(context));
  context.startingUpdatedAtMs = publication?.updatedAtMs ?? null;
  context.startingBytes = publication?.bytes ?? null;
}

function publishSafeFailure(context: SidecarRequestContext): void {
  publishAtomicStatus(context, 'failed', 'start_failed', (filePath) => shouldPublishFailure(context, filePath));
}

type EventListener = (...args: unknown[]) => void;
type EventfulChild = CompanySidecarChild & {
  on?: (event: string, listener: EventListener) => unknown;
  once?: (event: string, listener: EventListener) => unknown;
  removeListener?: (event: string, listener: EventListener) => unknown;
};

function spawnSidecar(
  action: CompanySidecarAction,
  options: CompanySidecarRequestOptions,
  context: SidecarRequestContext,
): Promise<CompanySidecarRequestResult> {
  const startScript = scriptPath(context.root, action);
  if (!fs.existsSync(startScript)) {
    publishSafeFailure(context);
    return Promise.reject(new CompanySidecarControlError('start_failed'));
  }
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', startScript,
    '-Root', context.root,
  ] as const;
  const spawnImpl = options.spawnImpl || ((command, spawnArgs, spawnOptions) => (
    nodeSpawn(command, spawnArgs, spawnOptions) as ChildProcess
  ));

  return new Promise<CompanySidecarRequestResult>((resolve, reject) => {
    let settled = false;
    let child: CompanySidecarChild | null = null;
    let eventChild: EventfulChild | null = null;
    let hasLifecycleEvents = false;

    const removeSpawnListener = (): void => {
      if (!eventChild?.removeListener) return;
      eventChild.removeListener('spawn', onSpawn);
    };
    const removeErrorListener = (): void => {
      if (!eventChild?.removeListener) return;
      eventChild.removeListener('error', onError);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      // Keep the error listener attached after a successful spawn. Node may emit
      // a late asynchronous error, which must be swallowed rather than become
      // an unhandled EventEmitter exception or overwrite the ready status.
      removeSpawnListener();
      resolve({ accepted: true, action });
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      removeSpawnListener();
      removeErrorListener();
      publishSafeFailure(context);
      reject(new CompanySidecarControlError('start_failed'));
    };
    const onSpawn: EventListener = () => succeed();
    const onError: EventListener = () => fail();

    try {
      child = spawnImpl('powershell.exe', args, {
        windowsHide: true,
        // Do NOT use `detached: true` here: on Windows it maps to
        // DETACHED_PROCESS, and a console-less powershell.exe then exits 0
        // immediately without ever executing the -File script (verified
        // against the packaged install). stdio 'ignore' + unref() already
        // decouple the controller from this Node process.
        stdio: 'ignore',
        cwd: context.root,
        env: {
          ...process.env,
          CREATIVE_STUDIO_SIDECAR_REQUEST_ID: context.requestId,
        },
      });
      if (!child || typeof child.unref !== 'function') throw new Error('spawn failed');
      eventChild = child as EventfulChild;
      if (typeof eventChild.once === 'function') eventChild.once('spawn', onSpawn);
      else if (typeof eventChild.on === 'function') eventChild.on('spawn', onSpawn);
      if (typeof eventChild.on === 'function') {
        eventChild.on('error', onError);
        hasLifecycleEvents = true;
      } else if (typeof eventChild.once === 'function') {
        eventChild.once('error', onError);
        hasLifecycleEvents = true;
      }
      child.unref();
      // Test doubles predating lifecycle events are accepted after unref. A real
      // ChildProcess always has `once` and therefore settles on `spawn`/`error`.
      if (!hasLifecycleEvents) succeed();
    } catch {
      fail();
    }
  });
}

/**
 * Request an asynchronous, fixed-layout sidecar action. Same-action starts
 * coalesce in this Node process; restart has its own key and is never swallowed
 * by an in-flight start request.
 */
export function requestCompanySidecar(
  action: CompanySidecarAction,
  options: CompanySidecarRequestOptions = {},
): Promise<CompanySidecarRequestResult> {
  if (!isAction(action)) return Promise.reject(new CompanySidecarControlError('invalid_action'));
  const existing = inFlight.get(action);
  if (existing) return existing;
  const context = beginRequest(options);
  publishStarting(context);
  const request = Promise.resolve().then(() => spawnSidecar(action, options, context));
  inFlight.set(action, request);
  void request.finally(() => {
    if (inFlight.get(action) === request) inFlight.delete(action);
  }).catch(() => { /* the original promise carries the stable error */ });
  return request;
}

/** Test-only reset; no production caller should need to clear in-flight state. */
export function resetCompanySidecarControllerForTests(): void {
  inFlight.clear();
  latestRequestTokenByRoot.clear();
}
