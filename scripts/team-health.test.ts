import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensions = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
interface ResolvedModule { url: string; format?: string | null; shortCircuit?: boolean }
type NextResolve = (specifier: string, context?: unknown) => ResolvedModule;
const { registerHooks } = module as unknown as {
  registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const candidate = fs.existsSync(base) && fs.statSync(base).isFile()
        ? base : extensions.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
      if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
        if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
        if (!specifier.startsWith('/')) return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

const {
  initializeTeamRuntimeState,
  markTeamRuntimeFailed,
  resetTeamRuntimeStateForTests,
  setTeamRuntimePhase,
} = await import('../lib/team-service/runtime/state.ts');
const { GET: live } = await import('../app/api/team/health/live/route.ts');
const { GET: ready } = await import('../app/api/team/health/ready/route.ts');

try {
  resetTeamRuntimeStateForTests();
  const liveResponse = await live();
  assert.equal(liveResponse.status, 200);
  assert.equal(liveResponse.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await liveResponse.json(), { live: true });

  const notReady = await ready();
  assert.equal(notReady.status, 503);
  assert.equal(notReady.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await notReady.json(), {
    ready: false,
    maintenance: true,
    phase: 'idle',
  });

  initializeTeamRuntimeState({ instanceId: 'health-instance', fence: 1 });
  markTeamRuntimeFailed('identity_unavailable');
  assert.equal((await live()).status, 200, '业务不可用时仍须保留进程活性探测');
  const failedReadiness = await ready();
  assert.equal(failedReadiness.status, 503);
  assert.deepEqual(await failedReadiness.json(), {
    ready: false,
    maintenance: true,
    phase: 'failed',
  }, '公共 readiness 不暴露内部错误码或实例诊断');

  initializeTeamRuntimeState({ instanceId: 'health-instance', fence: 1 });
  setTeamRuntimePhase('ready', { ready: true, maintenance: false });
  const readyResponse = await ready();
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), {
    ready: true,
    maintenance: false,
    phase: 'ready',
  });

  console.log('team health tests passed');
} finally {
  resetTeamRuntimeStateForTests();
}
