import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-instrumentation-'));
const workerPath = fileURLToPath(new URL('./team-instrumentation-worker.ts', import.meta.url));

function run(mode: 'local' | 'server', corruptCore = false, env: Record<string, string> = {}): Promise<Record<string, unknown>> {
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
      ...env,
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
    batchSchedulerStarted: true,
    scriptStudioSchedulerStarted: false,
    ready: true,
    code: null,
    teamSchema: true,
    executionSchema: true,
    shutdown: { stopped: true, pendingTasks: 0 },
  }, 'server 在受控 runtime 阶段启动批量恢复；身份结构就绪后开放登录，不依赖页面访问');

  const corruptCore = await run('server', true);
  assert.deepEqual(corruptCore, {
    mode: 'server',
    batchSchedulerStarted: false,
    scriptStudioSchedulerStarted: false,
    ready: false,
    code: 'SQLITE_NOTADB',
    teamSchema: null,
    executionSchema: null,
    shutdown: { stopped: true, pendingTasks: 0 },
  }, 'core 初始化失败时保留最小健康状态，不进入团队迁移或旧 worker');

  const disabled = await run('server', false, { CREATIVE_STUDIO_MODULE_BATCH: '0' });
  assert.equal(disabled.batchSchedulerStarted, false, '批量模块关闭时不得创建 worker');
  assert.equal(disabled.ready, true, '关闭批量不阻断其余模块 readiness');

  const scriptStudioEnabled = await run('server', false, {
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '1',
  });
  assert.equal(scriptStudioEnabled.scriptStudioSchedulerStarted, true, '显式授权后详情页脚本无需页面访问即可恢复');

  const local = await run('local');
  assert.deepEqual(local, {
    mode: 'local',
    batchSchedulerStarted: true,
    scriptStudioSchedulerStarted: false,
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
