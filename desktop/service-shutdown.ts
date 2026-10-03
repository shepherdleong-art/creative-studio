import { execFile, type ChildProcess } from 'node:child_process';

import { isAlive, requestTimeoutSignal } from './service-ready';

// The shell's graceful wait window must stay strictly longer than the
// service's total shutdown budget, so the service can finish its own cleanup
// before the shell escalates to process-group termination.
export const SHUTDOWN_REQUEST_TIMEOUT_MS = 15_000;
export const GRACEFUL_EXIT_TIMEOUT_MS = 20_000;
export const FORCE_EXIT_TIMEOUT_MS = 2_000;

function forceTerminateWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
    }, () => resolve());
  });
}

async function requestShutdown(origin: string): Promise<void> {
  const request = requestTimeoutSignal(SHUTDOWN_REQUEST_TIMEOUT_MS);
  try {
    await fetch(`${origin}/api/shutdown`, {
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

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isAlive(child)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve();
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

async function killServiceTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const pid = child.pid;
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
      child.kill(signal);
    } catch {
      // The process may have exited between isAlive() and kill().
    }
  }
}

export async function stopServiceProcess(child: ChildProcess, origin: string | null): Promise<void> {
  if (origin && isAlive(child)) {
    await requestShutdown(origin);
  }
  await waitForExit(child, GRACEFUL_EXIT_TIMEOUT_MS);
  if (isAlive(child)) {
    await killServiceTree(child, 'SIGTERM');
    await waitForExit(child, FORCE_EXIT_TIMEOUT_MS);
  }
  if (isAlive(child)) {
    await killServiceTree(child, 'SIGKILL');
    await waitForExit(child, FORCE_EXIT_TIMEOUT_MS);
  }
}
