import type { ChildProcess } from 'node:child_process';

export const READY_PREFIX = '__CREATIVE_STUDIO_READY__';
export const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
export const DEFAULT_HEALTH_INTERVAL_MS = 150;
const HEALTH_FETCH_TIMEOUT_MS = 2_000;

export class DesktopServiceError extends Error {
  readonly stderrTail: string;

  constructor(message: string, stderrTail = '') {
    super(stderrTail ? `${message}\n${stderrTail}` : message);
    this.name = 'DesktopServiceError';
    this.stderrTail = stderrTail;
  }
}

export interface ReadyMessage {
  port: number;
  instanceId: string;
}

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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function requestTimeoutSignal(milliseconds: number): {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function exactResponseOrigin(responseUrl: string, expectedOrigin: string): boolean {
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

export interface ReadyTracker {
  readonly origin: string | null;
  readonly lastError: string | undefined;
  onStdout(chunk: string | Buffer): void;
  ready(): Promise<void>;
  rejectReady(error: Error): void;
}

// Parses the service's stdout for the single ready marker and exposes a
// promise that settles as soon as the marker is validated. The launch secret
// stays process-local: the instanceId in the marker must match this launch.
export function createReadyTracker(instanceId: string, getStderrTail: () => string): ReadyTracker {
  let stdoutBuffer = '';
  let readyMessage: ReadyMessage | null = null;
  let lastError: string | undefined;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const failReady = (message: string): void => {
    lastError = message;
    readyReject?.(new DesktopServiceError(message, getStderrTail()));
  };

  const readReadyLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith(READY_PREFIX)) {
      return;
    }

    if (readyMessage) {
      failReady('私有 Node 服务重复回传 ready 标记');
      return;
    }

    const jsonText = trimmed.slice(READY_PREFIX.length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      failReady('私有 Node 服务的 ready 标记不是合法 JSON');
      return;
    }
    if (!isReadyMessage(parsed)) {
      failReady('私有 Node 服务的 ready 标记缺少合法 port/instanceId');
      return;
    }
    if (parsed.instanceId !== instanceId) {
      failReady('私有 Node 服务 ready 身份与本次启动不一致');
      return;
    }

    readyMessage = parsed;
    readyResolve?.();
  };

  return {
    get origin() {
      return readyMessage ? `http://127.0.0.1:${readyMessage.port}` : null;
    },
    get lastError() {
      return lastError;
    },
    onStdout(chunk: string | Buffer) {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        readReadyLine(line);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    },
    ready: () => readyPromise,
    rejectReady: (error) => {
      readyReject?.(error);
    },
  };
}

export interface HealthCheckOptions {
  origin: string;
  instanceId: string;
  child: ChildProcess;
  timeoutMs: number;
  intervalMs: number;
  getStderrTail(): string;
}

// Polls /api/desktop/health until the running instance confirms the launch
// instanceId. The response URL must stay exactly on the announced origin.
export async function waitForServiceHealth(options: HealthCheckOptions): Promise<void> {
  const origin = options.origin;
  const deadline = Date.now() + options.timeoutMs;
  let lastFailure = '健康接口尚未就绪';

  while (Date.now() < deadline) {
    if (!isAlive(options.child)) {
      throw new DesktopServiceError(
        '私有 Node 服务在健康检查完成前退出',
        options.getStderrTail(),
      );
    }

    try {
      const response = await fetchHealth(origin, options.timeoutMs);
      if (!response.ok) {
        lastFailure = `健康接口返回 HTTP ${response.status}`;
      } else if (!exactResponseOrigin(response.url, origin)) {
        throw new DesktopServiceError('健康接口发生了不允许的 origin 跳转');
      } else {
        const payload: unknown = await response.json();
        if (
          payload &&
          typeof payload === 'object' &&
          (payload as Record<string, unknown>).instanceId === options.instanceId
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

    await wait(Math.min(options.intervalMs, Math.max(1, deadline - Date.now())));
  }

  throw new DesktopServiceError(
    `健康检查超时：${lastFailure}`,
    options.getStderrTail(),
  );
}

async function fetchHealth(origin: string, healthTimeoutMs: number): Promise<Response> {
  const request = requestTimeoutSignal(Math.min(HEALTH_FETCH_TIMEOUT_MS, healthTimeoutMs));
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
