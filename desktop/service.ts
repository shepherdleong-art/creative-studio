import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';

const READY_PREFIX = '__CREATIVE_STUDIO_READY__';
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 150;
// The shell's graceful wait window must stay strictly longer than the
// service's total shutdown budget, so the service can finish its own cleanup
// before the shell escalates to process-group termination.
const SHUTDOWN_REQUEST_TIMEOUT_MS = 15_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 20_000;
const FORCE_EXIT_TIMEOUT_MS = 2_000;
const STDERR_TAIL_LIMIT = 12_000;
const SERVICE_STATE_FILENAME = 'electron-service.json';

export interface StartServiceOptions {
  nodePath: string;
  serverEntry: string;
  serverRoot: string;
  dataRoot: string;
  instanceId?: string;
  desktopSecret?: string;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  environment?: NodeJS.ProcessEnv;
  /**
   * Called once when the service exits on its own after becoming ready — the
   * in-app shutdown button exits the Node process, and a crash looks the same
   * from here. Either way the shell has nothing left to display, so the caller
   * is expected to tear the whole application down.
   */
  onUnexpectedExit?: () => void;
}

export interface DesktopService {
  readonly origin: string;
  readonly instanceId: string;
  getStatus(): DesktopServiceStatus;
  stop(): Promise<void>;
}

export type DesktopServiceState =
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface DesktopServiceStatus {
  state: DesktopServiceState;
  origin?: string;
  instanceId?: string;
  error?: string;
}

export class DesktopServiceError extends Error {
  readonly stderrTail: string;

  constructor(message: string, stderrTail = '') {
    super(stderrTail ? `${message}\n${stderrTail}` : message);
    this.name = 'DesktopServiceError';
    this.stderrTail = stderrTail;
  }
}

interface ReadyMessage {
  port: number;
  instanceId: string;
}

interface PersistedServiceState {
  version: 1;
  origin: string;
  instanceId: string;
}

function serviceStatePath(dataRoot: string): string {
  return join(dataRoot, 'storage', 'run', SERVICE_STATE_FILENAME);
}

function persistServiceState(filePath: string, state: PersistedServiceState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${state.instanceId}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporaryPath, filePath);
  } catch {
    // Windows cannot replace an existing file with rename. The target is the
    // exact controlled state path and is removed only for this atomic update.
    try { unlinkSync(filePath); } catch { /* stale state may already be gone */ }
    renameSync(temporaryPath, filePath);
  }
}

function clearServiceState(filePath: string, instanceId: string): void {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedServiceState>;
    if (parsed.instanceId === instanceId) unlinkSync(filePath);
  } catch {
    // Stale or already-removed state must not prevent process shutdown.
  }
}

type InternalState = DesktopServiceStatus['state'];

function isReadyMessage(value: unknown): value is ReadyMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.port === 'number' &&
    Number.isInteger(candidate.port) &&
    candidate.port >= 1 &&
    candidate.port <= 65_535 &&
    typeof candidate.instanceId === 'string' &&
    candidate.instanceId.length > 0
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function forceTerminateWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
    }, () => resolve());
  });
}

function requestTimeoutSignal(milliseconds: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

class ManagedDesktopService implements DesktopService {
  readonly instanceId: string;

  private state: InternalState = 'starting';
  private error: string | undefined;
  private readonly child: ChildProcess;
  private readonly healthTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly stateFile: string;
  private readonly onUnexpectedExit: (() => void) | undefined;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readyMessage: ReadyMessage | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly readyPromise: Promise<void>;
  private stopPromise: Promise<void> | null = null;

  private readonly onStdout = (chunk: string | Buffer): void => {
    this.stdoutBuffer += chunk.toString();
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.readStdoutLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  };

  private readonly onStderr = (chunk: string | Buffer): void => {
    this.stderrBuffer = `${this.stderrBuffer}${chunk.toString()}`.slice(
      -STDERR_TAIL_LIMIT,
    );
  };

  private readonly onChildError = (error: Error): void => {
    const message = `私有 Node 服务进程错误：${error.message}`;
    this.error = message;
    if (this.state === 'starting') {
      this.readyReject?.(new DesktopServiceError(message, this.stderrBuffer));
    } else if (this.state !== 'stopping' && this.state !== 'stopped') {
      this.state = 'error';
    }
  };

  private readonly onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.state === 'starting') {
      const detail = signal ? `signal=${signal}` : `code=${String(code)}`;
      const message = `私有 Node 服务在就绪前退出（${detail}）`;
      this.error = message;
      this.readyReject?.(new DesktopServiceError(message, this.stderrBuffer));
      return;
    }

    if (this.state !== 'stopping' && this.state !== 'stopped') {
      this.state = 'error';
      this.error = `私有 Node 服务意外退出（${signal ? `signal=${signal}` : `code=${String(code)}`}）`;
      // Fires for the in-app shutdown button as well as for a genuine crash.
      // stop() never reaches here because it moves the state to 'stopping'
      // first, so this cannot re-enter an already-running teardown.
      this.onUnexpectedExit?.();
    }
  };

  constructor(
    child: ChildProcess,
    instanceId: string,
    healthTimeoutMs: number,
    healthIntervalMs: number,
    stateFile: string,
    onUnexpectedExit?: () => void,
  ) {
    this.child = child;
    this.instanceId = instanceId;
    this.healthTimeoutMs = healthTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    this.stateFile = stateFile;
    this.onUnexpectedExit = onUnexpectedExit;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', this.onStdout);
    child.stderr?.on('data', this.onStderr);
    child.once('error', this.onChildError);
    child.once('exit', this.onChildExit);
  }

  getStatus(): DesktopServiceStatus {
    return {
      state: this.state,
      origin: this.readyMessage ? this.origin : undefined,
      instanceId: this.instanceId,
      error: this.error,
    };
  }

  async start(startupTimeoutMs: number): Promise<void> {
    const timer = setTimeout(() => {
      this.readyReject?.(
        new DesktopServiceError(
          `私有 Node 服务在 ${startupTimeoutMs}ms 内没有回传端口`,
          this.stderrBuffer,
        ),
      );
    }, startupTimeoutMs);

    try {
      await this.readyPromise;
      await this.waitForHealth();
      this.state = 'ready';
    } finally {
      clearTimeout(timer);
    }
  }

  persistState(): void {
    persistServiceState(this.stateFile, {
      version: 1,
      origin: this.origin,
      instanceId: this.instanceId,
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private readStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith(READY_PREFIX)) {
      return;
    }

    if (this.readyMessage) {
      this.failReady('私有 Node 服务重复回传 ready 标记');
      return;
    }

    const jsonText = trimmed.slice(READY_PREFIX.length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      this.failReady('私有 Node 服务的 ready 标记不是合法 JSON');
      return;
    }
    if (!isReadyMessage(parsed)) {
      this.failReady('私有 Node 服务的 ready 标记缺少合法 port/instanceId');
      return;
    }
    if (parsed.instanceId !== this.instanceId) {
      this.failReady('私有 Node 服务 ready 身份与本次启动不一致');
      return;
    }

    this.readyMessage = parsed;
    this.readyResolve?.();
  }

  private failReady(message: string): void {
    this.error = message;
    this.readyReject?.(new DesktopServiceError(message, this.stderrBuffer));
  }

  private async waitForHealth(): Promise<void> {
    const origin = this.origin;
    const deadline = Date.now() + this.healthTimeoutMs;
    let lastFailure = '健康接口尚未就绪';

    while (Date.now() < deadline) {
      if (!isAlive(this.child)) {
        throw new DesktopServiceError(
          '私有 Node 服务在健康检查完成前退出',
          this.stderrBuffer,
        );
      }

      try {
        const response = await this.fetchHealth(origin);
        if (!response.ok) {
          lastFailure = `健康接口返回 HTTP ${response.status}`;
        } else if (!exactResponseOrigin(response.url, origin)) {
          throw new DesktopServiceError('健康接口发生了不允许的 origin 跳转');
        } else {
          const payload: unknown = await response.json();
          if (
            payload &&
            typeof payload === 'object' &&
            (payload as Record<string, unknown>).instanceId === this.instanceId
          ) {
            return;
          }
          throw new DesktopServiceError('健康接口身份与本次启动不一致');
        }
      } catch (error: unknown) {
        if (error instanceof DesktopServiceError && error.message.includes('身份')) {
          throw error;
        }
        lastFailure = errorMessage(error);
      }

      await wait(Math.min(this.healthIntervalMs, Math.max(1, deadline - Date.now())));
    }

    throw new DesktopServiceError(
      `健康检查超时：${lastFailure}`,
      this.stderrBuffer,
    );
  }

  private async fetchHealth(origin: string): Promise<Response> {
    const request = requestTimeoutSignal(Math.min(2_000, this.healthTimeoutMs));
    try {
      return await fetch(`${origin}/api/desktop/health`, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: request.signal,
      });
    } finally {
      request.dispose();
    }
  }

  private async stopInternal(): Promise<void> {
    this.state = 'stopping';
    try {
      if (this.readyMessage && isAlive(this.child)) {
        await this.requestShutdown();
      }
      await this.waitForExit(GRACEFUL_EXIT_TIMEOUT_MS);
      if (isAlive(this.child)) {
        await this.kill('SIGTERM');
        await this.waitForExit(FORCE_EXIT_TIMEOUT_MS);
      }
      if (isAlive(this.child)) {
        await this.kill('SIGKILL');
        await this.waitForExit(FORCE_EXIT_TIMEOUT_MS);
      }
    } finally {
      this.removeListeners();
      clearServiceState(this.stateFile, this.instanceId);
      this.state = 'stopped';
    }
  }

  private async requestShutdown(): Promise<void> {
    const request = requestTimeoutSignal(SHUTDOWN_REQUEST_TIMEOUT_MS);
    try {
      await fetch(`${this.origin}/api/shutdown`, {
        method: 'POST',
        redirect: 'error',
        signal: request.signal,
      });
    } catch {
      // A missing response is expected when the route schedules process exit.
    } finally {
      request.dispose();
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (!isAlive(this.child)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.removeListener('exit', onExit);
        resolve();
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.child.once('exit', onExit);
    });
  }

  private async kill(signal: NodeJS.Signals): Promise<void> {
    const pid = this.child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      // Windows has no POSIX process groups. taskkill /T /F is the bounded
      // fallback that also reaches ffmpeg descendants of the service.
      await forceTerminateWindowsTree(pid);
      return;
    }
    try {
      // The child is detached on Unix, so its negative pid addresses the
      // complete service process group rather than leaving ffmpeg orphaned.
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // The process may have exited between isAlive() and kill().
      }
    }
  }

  private removeListeners(): void {
    this.child.stdout?.removeListener('data', this.onStdout);
    this.child.stderr?.removeListener('data', this.onStderr);
    this.child.removeListener('error', this.onChildError);
    this.child.removeListener('exit', this.onChildExit);
  }

  get origin(): string {
    if (!this.readyMessage) {
      throw new Error('私有 Node 服务尚未回传端口');
    }
    return `http://127.0.0.1:${this.readyMessage.port}`;
  }
}

function exactResponseOrigin(responseUrl: string, expectedOrigin: string): boolean {
  try {
    const actual = new URL(responseUrl);
    const expected = new URL(expectedOrigin);
    return (
      actual.protocol === expected.protocol &&
      actual.hostname === expected.hostname &&
      actual.port === expected.port
    );
  } catch {
    return false;
  }
}

export async function startService(
  options: StartServiceOptions,
): Promise<DesktopService> {
  if (!options.nodePath || !options.serverEntry || !options.serverRoot || !options.dataRoot) {
    throw new TypeError('私有 Node 服务启动参数不完整');
  }
  if (!existsSync(options.serverEntry)) {
    throw new DesktopServiceError(`服务入口不存在：${options.serverEntry}`);
  }
  if (!existsSync(join(options.serverRoot, 'server.js'))) {
    throw new DesktopServiceError(`standalone server.js 不存在：${options.serverRoot}`);
  }

  const instanceId = options.instanceId ?? randomUUID();
  const child = spawn(options.nodePath, [options.serverEntry], {
    cwd: options.serverRoot,
    env: {
      ...process.env,
      ...options.environment,
      PORT: '0',
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      CREATIVE_STUDIO_INSTANCE_ID: instanceId,
      ...(options.desktopSecret ? { CREATIVE_STUDIO_DESKTOP_SECRET: options.desktopSecret } : {}),
      CREATIVE_STUDIO_DATA_ROOT: options.dataRoot,
      CREATIVE_STUDIO_SERVER_ROOT: options.serverRoot,
      CREATIVE_STUDIO_STANDALONE_SERVER: join(options.serverRoot, 'server.js'),
      CREATIVE_STUDIO_DESKTOP: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  const service = new ManagedDesktopService(
    child,
    instanceId,
    options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
    serviceStatePath(options.dataRoot),
    options.onUnexpectedExit,
  );

  try {
    await service.start(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    service.persistState();
    return service;
  } catch (error: unknown) {
    await service.stop();
    throw error;
  }
}
