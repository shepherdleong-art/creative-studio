import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicJson } from './atomic-json';
import { ClientUpdateCoordinator, type UpdateResult } from './update-coordinator';

export interface UpdateHelperJob {
  schemaVersion: 1;
  jobId: string;
  installRoot: string;
  manifestUrl: string;
  serverOrigin: string;
  currentPid: number;
  platform: 'win32' | 'darwin';
  arch: 'x64' | 'arm64';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${description} 超时`);
    await delay(100);
  }
}

function jobPaths(job: UpdateHelperJob): { directory: string; pauseRequest: string; pauseAck: string; stopRequest: string; result: string } {
  const directory = path.join(job.installRoot, 'updates', 'jobs');
  return {
    directory,
    pauseRequest: path.join(directory, `${job.jobId}.pause-request`),
    pauseAck: path.join(directory, `${job.jobId}.pause-ack`),
    stopRequest: path.join(directory, `${job.jobId}.stop-request`),
    result: path.join(directory, `${job.jobId}.result.json`),
  };
}

function currentStateSchema(stateRoot: string): number {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateRoot, 'state.json'), 'utf8')) as { schemaVersion?: unknown };
    return typeof value.schemaVersion === 'number' ? value.schemaVersion : 1;
  } catch { return 1; }
}

export function createNativeUpdateProcessControl(job: UpdateHelperJob, timeouts: {
  stopCurrentTimeoutMs?: number;
  healthTimeoutMs?: number;
} = {}) {
  const paths = jobPaths(job);
  const stateRoot = path.join(job.installRoot, 'client-state');
  const gatePath = path.join(stateRoot, 'run', 'transfer-gate.json');
  return {
    pauseTransfers: async () => {
      atomicJson(paths.pauseRequest, { jobId: job.jobId });
      await waitFor(() => fs.existsSync(paths.pauseAck), 15_000, '主进程暂停传输确认');
      atomicJson(gatePath, { schemaVersion: 1, blocked: true, jobId: job.jobId });
    },
    resumeTransfers: async () => {
      atomicJson(gatePath, { schemaVersion: 1, blocked: false, jobId: job.jobId });
      atomicJson(path.join(paths.directory, `${job.jobId}.resume-request`), { jobId: job.jobId });
    },
    stopCurrent: async () => {
      atomicJson(paths.stopRequest, { jobId: job.jobId, pid: job.currentPid });
      await waitFor(() => !running(job.currentPid), timeouts.stopCurrentTimeoutMs ?? 20_000, '旧客户端进程退出');
    },
    startVersion: async ({ releaseId, directory, transfersEnabled }: {
      releaseId: string; directory: string; stateRoot: string; transfersEnabled: false;
    }) => {
      if (transfersEnabled) throw new Error('健康确认前禁止启动可写传输');
      const executable = job.platform === 'win32'
        ? path.join(directory, 'electron', 'electron.exe')
        : path.join(directory, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron');
      if (!fs.existsSync(executable)) throw new Error('新版本缺少受控 Electron 可执行文件');
      const healthPath = path.join(stateRoot, 'run', 'client-health.json');
      try { fs.rmSync(healthPath); } catch { /* no stale health */ }
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      Object.assign(environment, {
        CREATIVE_STUDIO_CLIENT_MODE: 'remote',
        CREATIVE_STUDIO_SERVER_ORIGIN: job.serverOrigin,
        CREATIVE_STUDIO_CLIENT_INSTALL_ROOT: job.installRoot,
        CREATIVE_STUDIO_CLIENT_STATE_ROOT: stateRoot,
        CREATIVE_STUDIO_CLIENT_RELEASE_ID: releaseId,
      });
      const child = spawn(executable, [directory], {
        env: environment,
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      let exited = false;
      child.once('error', () => { exited = true; });
      child.once('exit', () => { exited = true; });
      return {
        waitForHealth: async () => {
          const deadline = Date.now() + (timeouts.healthTimeoutMs ?? 20_000);
          while (Date.now() < deadline) {
            if (fs.existsSync(healthPath)) {
              try {
                const health = JSON.parse(fs.readFileSync(healthPath, 'utf8')) as {
                  releaseId?: string; pid?: number; healthy?: boolean; stateSchema?: number; apiVersion?: number;
                };
                if (health.releaseId === releaseId && health.pid === child.pid) {
                  return {
                    healthy: health.healthy === true,
                    stateSchema: health.stateSchema ?? currentStateSchema(stateRoot),
                    apiVersion: health.apiVersion ?? 1,
                  };
                }
              } catch { /* wait for atomic health write to finish */ }
            }
            if (exited) break;
            await delay(100);
          }
          return { healthy: false, stateSchema: currentStateSchema(stateRoot), apiVersion: 1 };
        },
        stop: async () => {
          if (!exited && child.pid && running(child.pid)) process.kill(child.pid);
          await waitFor(() => exited || !child.pid || !running(child.pid!), 5000, '新版本进程停止').catch(() => undefined);
        },
      };
    },
    stopVersion: async () => { /* startVersion owns and stops every partially started child */ },
  };
}

export async function runIndependentUpdateJob(jobFile: string): Promise<UpdateResult> {
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8')) as UpdateHelperJob;
  if (job.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(job.jobId)
    || path.resolve(job.installRoot) !== path.resolve(path.join(jobFile, '..', '..', '..'))
    || !Number.isSafeInteger(job.currentPid) || job.currentPid === process.pid) {
    throw new Error('独立更新任务文件或安装根无效');
  }
  if (new URL(job.manifestUrl).origin !== new URL(job.serverOrigin).origin
    || new URL(job.manifestUrl).protocol !== 'https:') throw new Error('更新 URL 不受控');
  const paths = jobPaths(job);
  const coordinator = new ClientUpdateCoordinator({
    rootDir: job.installRoot,
    publicKey: fs.readFileSync(path.join(job.installRoot, 'update-public-key.pem'), 'utf8'),
    platform: job.platform,
    arch: job.arch,
    trustedOrigins: [new URL(job.serverOrigin).origin],
    fetch: (url) => fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000) }),
    processControl: createNativeUpdateProcessControl(job),
  });
  const result = await coordinator.applyFromUrl(job.manifestUrl);
  atomicJson(paths.result, { schemaVersion: 1, jobId: job.jobId, ...result });
  return result;
}

export interface SpawnHelperOptions {
  installRoot: string;
  manifestUrl: string;
  serverOrigin: string;
  currentPid: number;
  onPauseRequested(): Promise<void>;
  onResumeRequested(): Promise<void>;
  onStopRequested(): Promise<void>;
  onResult(result: UpdateResult): void;
}

export async function spawnIndependentUpdateHelper(options: SpawnHelperOptions): Promise<{ jobId: string }> {
  const installRoot = path.resolve(options.installRoot);
  const manifest = new URL(options.manifestUrl);
  const server = new URL(options.serverOrigin);
  if (manifest.protocol !== 'https:' || server.protocol !== 'https:' || manifest.origin !== server.origin) {
    throw new Error('只接受来自当前服务的受控 HTTPS 更新 URL');
  }
  const helper = path.join(installRoot, 'helper', 'update-helper.js');
  if (!fs.existsSync(helper)) throw new Error('独立更新助手缺失，请使用受控修复包');
  const jobId = randomUUID();
  const job: UpdateHelperJob = {
    schemaVersion: 1, jobId, installRoot, manifestUrl: manifest.href, serverOrigin: server.origin,
    currentPid: options.currentPid, platform: process.platform === 'win32' ? 'win32' : 'darwin',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  };
  const paths = jobPaths(job);
  const jobFile = path.join(paths.directory, `${jobId}.json`);
  atomicJson(jobFile, job);
  const child = spawn(process.execPath, [helper, jobFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  let stopping = false;
  let settled = false;
  let busy = false;
  const finish = (result: UpdateResult) => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    options.onResult(result);
  };
  const timer = setInterval(() => {
    if (busy || settled) return;
    busy = true;
    void (async () => {
      if (fs.existsSync(paths.pauseRequest) && !fs.existsSync(paths.pauseAck)) {
        await options.onPauseRequested();
        atomicJson(paths.pauseAck, { jobId });
      }
      if (fs.existsSync(paths.stopRequest) && !stopping) {
        stopping = true;
        await options.onStopRequested();
      }
      const resumeRequest = path.join(paths.directory, `${jobId}.resume-request`);
      if (fs.existsSync(resumeRequest)) {
        await options.onResumeRequested();
        try { fs.rmSync(resumeRequest); } catch { /* already consumed */ }
      }
      if (fs.existsSync(paths.result)) {
        const result = JSON.parse(fs.readFileSync(paths.result, 'utf8')) as UpdateResult;
        finish(result);
      }
    })().catch(() => undefined).finally(() => { busy = false; });
  }, 100);
  timer.unref();
  child.once('exit', () => {
    if (settled) return;
    if (fs.existsSync(paths.result)) {
      try { finish(JSON.parse(fs.readFileSync(paths.result, 'utf8')) as UpdateResult); } catch { /* monitor retries the result */ }
      return;
    }
    if (!stopping) {
      void options.onResumeRequested().catch(() => undefined).finally(() => finish({
        status: 'rejected', message: '更新助手异常退出，已保留当前版本并恢复本机传输。',
      }));
    } else {
      finish({ status: 'recovery_required', message: '更新助手在版本切换期间退出；已保留版本、快照和下载，请重新启动修复。' });
    }
  });
  return { jobId };
}

if (require.main === module) {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error('缺少独立更新任务文件');
  runIndependentUpdateJob(path.resolve(jobFile)).then((result) => {
    process.exitCode = result.status === 'committed' || result.status === 'rolled_back' ? 0 : 2;
  }).catch((error: unknown) => {
    process.exitCode = 2;
    console.error(error instanceof Error ? error.message : String(error));
  });
}
