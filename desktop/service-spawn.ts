import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { app } from 'electron';

import {
  createReadyTracker,
  DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  DesktopServiceError,
  waitForServiceHealth,
  type ReadyTracker,
} from './service-ready';
import { clearServiceState, persistServiceState, serviceStatePath } from './service-state';
import { stopServiceProcess } from './service-shutdown';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LIMIT = 12_000;

// The standalone server never loads .env files itself, so the shell injects
// <dataRoot>/.env.local (COS credentials, etc.) into the child environment.
// Explicit process env always wins over file values, mirroring Next.js dev.
function loadEnvFile(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

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

type InternalState = DesktopServiceStatus['state'];

export function resolveNodeExecutable(): string {
  const explicitNode = process.env.CREATIVE_STUDIO_NODE;
  if (explicitNode) {
    return explicitNode;
  }

  if (app.isPackaged) {
    const bundledNode = join(
      process.resourcesPath,
      'app',
      'runtime',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    if (existsSync(bundledNode)) {
      return bundledNode;
    }
    throw new Error(`安装包缺少私有 Node 运行时：${bundledNode}`);
  }

  const npmNode = process.env.npm_node_execpath;
  if (npmNode && npmNode !== process.execPath) {
    return npmNode;
  }

  // Electron's process.execPath is the Electron binary, not a Node runtime.
  // In development, locate the regular Node binary from PATH instead of
  // accidentally launching a second Electron process as the service.
  if (process.versions.electron) {
    const executable = process.platform === 'win32' ? 'node.exe' : 'node';
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (!directory) {
        continue;
      }
      const candidate = join(directory, executable);
      if (candidate === process.execPath || !existsSync(candidate)) {
        continue;
      }
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking through PATH entries.
      }
    }
    throw new Error(
      '找不到私有 Node 运行时，请设置 CREATIVE_STUDIO_NODE 指向 Node 20+ 可执行文件',
    );
  }

  return process.execPath;
}

export function resolveServicePaths(): Pick<StartServiceOptions, 'serverRoot' | 'serverEntry'> {
  const projectRoot = resolve(__dirname, '..');
  const standaloneRoot =
    process.env.CREATIVE_STUDIO_STANDALONE_ROOT ??
    join(projectRoot, '.next', 'standalone');
  const bundledEntry = join(standaloneRoot, 'runtime', 'server-entry.js');
  const sourceEntry = join(projectRoot, 'runtime', 'server-entry.js');

  if (existsSync(bundledEntry)) {
    return { serverRoot: standaloneRoot, serverEntry: bundledEntry };
  }
  if (existsSync(sourceEntry)) {
    return { serverRoot: standaloneRoot, serverEntry: sourceEntry };
  }
  throw new Error(
    `找不到 standalone 服务入口，请先执行 npm run build：${bundledEntry}`,
  );
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
  private stderrBuffer = '';
  private readonly readyTracker: ReadyTracker;
  private stopPromise: Promise<void> | null = null;

  private readonly onStdout = (chunk: string | Buffer): void => {
    this.readyTracker.onStdout(chunk);
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
      this.readyTracker.rejectReady(new DesktopServiceError(message, this.stderrBuffer));
    } else if (this.state !== 'stopping' && this.state !== 'stopped') {
      this.state = 'error';
    }
  };

  private readonly onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.state === 'starting') {
      const detail = signal ? `signal=${signal}` : `code=${String(code)}`;
      const message = `私有 Node 服务在就绪前退出（${detail}）`;
      this.error = message;
      this.readyTracker.rejectReady(new DesktopServiceError(message, this.stderrBuffer));
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
    this.readyTracker = createReadyTracker(instanceId, () => this.stderrBuffer);
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
      origin: this.readyTracker.origin ?? undefined,
      instanceId: this.instanceId,
      error: this.error ?? this.readyTracker.lastError,
    };
  }

  async start(startupTimeoutMs: number): Promise<void> {
    const timer = setTimeout(() => {
      this.readyTracker.rejectReady(
        new DesktopServiceError(
          `私有 Node 服务在 ${startupTimeoutMs}ms 内没有回传端口`,
          this.stderrBuffer,
        ),
      );
    }, startupTimeoutMs);

    try {
      await this.readyTracker.ready();
      await waitForServiceHealth({
        origin: this.origin,
        instanceId: this.instanceId,
        child: this.child,
        timeoutMs: this.healthTimeoutMs,
        intervalMs: this.healthIntervalMs,
        getStderrTail: () => this.stderrBuffer,
      });
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

  private async stopInternal(): Promise<void> {
    this.state = 'stopping';
    try {
      await stopServiceProcess(this.child, this.readyTracker.origin);
    } finally {
      this.removeListeners();
      clearServiceState(this.stateFile, this.instanceId);
      this.state = 'stopped';
    }
  }

  private removeListeners(): void {
    this.child.stdout?.removeListener('data', this.onStdout);
    this.child.stderr?.removeListener('data', this.onStderr);
    this.child.removeListener('error', this.onChildError);
    this.child.removeListener('exit', this.onChildExit);
  }

  get origin(): string {
    const origin = this.readyTracker.origin;
    if (!origin) {
      throw new Error('私有 Node 服务尚未回传端口');
    }
    return origin;
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
      ...loadEnvFile(join(options.dataRoot, '.env.local')),
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
