import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-instrumentation-'));
const workerPath = fileURLToPath(new URL('./team-instrumentation-worker.ts', import.meta.url));

function run(mode: 'local' | 'server', corruptCore = false): Promise<Record<string, unknown>> {
  const root = path.join(fixtureRoot, corruptCore ? `${mode}-corrupt` : mode);
  fs.mkdirSync(root, { recursive: true });
  if (corruptCore) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'workbench.db'), 'not a sqlite database');
  }
  const child = spawn(process.execPath, [workerPath, mode, ...(corruptCore ? ['corrupt-core'] : [])], {
    env: {
      ...process.env,
      NEXT_RUNTIME: 'nodejs',
      CREATIVE_STUDIO_DATA_ROOT: root,
      CREATIVE_STUDIO_DEPLOYMENT_MODE: mode,
      CREATIVE_STUDIO_PORT: '3300',
      CREATIVE_STUDIO_DEPLOYMENT_ID: `deployment-${mode}`,
      CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
      CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
      CREATIVE_STUDIO_CANVAS_ENABLE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${mode} instrumentation 超时：${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`${mode} instrumentation 退出 ${code}：${stdout}\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`无法读取 ${mode} 结果：${stdout}\n${stderr}\n${String(error)}`));
      }
    });
  });
}

try {
  const server = await run('server');
  assert.deepEqual(server, {
    mode: 'server',
    batchSchedulerStarted: false,
    ready: true,
    code: null,
    teamSchema: true,
    executionSchema: true,
    shutdown: { stopped: true, pendingTasks: 0 },
  }, 'server 只跑共享迁移和分阶段组合；身份结构就绪后开放登录，不自动启动旧 worker');

  const corruptCore = await run('server', true);
  assert.deepEqual(corruptCore, {
    mode: 'server',
    batchSchedulerStarted: false,
    ready: false,
    code: 'SQLITE_NOTADB',
    teamSchema: null,
    executionSchema: null,
    shutdown: { stopped: true, pendingTasks: 0 },
  }, 'core 初始化失败时保留最小健康状态，不进入团队迁移或旧 worker');

  const local = await run('local');
  assert.deepEqual(local, {
    mode: 'local',
    batchSchedulerStarted: true,
    ready: false,
    code: null,
    teamSchema: false,
    executionSchema: false,
    shutdown: { stopped: true, pendingTasks: 0 },
  }, 'local 保留旧 instrumentation 自动恢复，且不创建团队/执行设施');

  console.log('team instrumentation tests passed');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
