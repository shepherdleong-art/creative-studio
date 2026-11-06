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

const dataRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'team-client-capabilities-'));
Object.assign(process.env, {
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DATA_ROOT: dataRoot,
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-ticket12',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_CLIENT_SUPPORTED_RANGE: '>=0.7.0 <0.8.0',
  CREATIVE_STUDIO_CLIENT_UPDATE_MANIFEST_URL: 'https://studio.example.test/client-updates/stable.json',
});

const { GET } = await import('../app/api/team/client-capabilities/route.ts');
const { POST: registerDevice } = await import('../app/api/team/devices/route.ts');
const { initializeTeamRuntimeState, setTeamRuntimePhase } = await import('../lib/team-service/runtime/state.ts');
initializeTeamRuntimeState({ instanceId: 'capabilities-test', fence: 1 });
setTeamRuntimePhase('ready', { ready: true, maintenance: false });

try {
  const current = await GET(new Request('https://studio.example.test/api/team/client-capabilities', {
    headers: { 'x-creative-studio-client-version': '0.7.1', 'x-creative-studio-client-api': '1' },
  }));
  assert.equal(current.status, 200);
  const capabilities = await current.json() as Record<string, unknown>;
  assert.equal(capabilities.deploymentId, 'deployment-ticket12');
  assert.equal(capabilities.apiVersion, 1);
  assert.equal(capabilities.supportedClientRange, '>=0.7.0 <0.8.0');
  assert.deepEqual(capabilities.uploadConstraints, {
    partSize: 8 * 1024 * 1024,
    maxFilesPerBatch: 100,
    maxFileSize: 1024 * 1024 * 1024 * 1024,
  });
  assert.equal(capabilities.compatible, true);
  assert.equal(capabilities.maintenance, false);

  const old = await GET(new Request('https://studio.example.test/api/team/client-capabilities', {
    headers: { 'x-creative-studio-client-version': '0.6.9', 'x-creative-studio-client-api': '1' },
  }));
  const oldCapabilities = await old.json() as Record<string, unknown>;
  assert.equal(oldCapabilities.compatible, false);
  assert.equal(oldCapabilities.reason, 'client_update_required');
  assert.deepEqual(oldCapabilities.update, {
    manifestUrl: 'https://studio.example.test/client-updates/stable.json',
  });

  const blocked = await registerDevice(new Request('https://studio.example.test/api/team/devices', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-creative-studio-client-version': '0.6.9',
      'x-creative-studio-client-api': '1',
    },
    body: '{}',
  }));
  assert.equal(blocked.status, 426, '旧客户端写请求必须在认证和业务执行之前失败关闭');
  assert.equal((await blocked.json() as { error?: string }).error, 'client_update_required');

  const apiMismatch = await GET(new Request('https://studio.example.test/api/team/client-capabilities', {
    headers: { 'x-creative-studio-client-version': '0.7.1', 'x-creative-studio-client-api': '0' },
  }));
  assert.equal((await apiMismatch.json() as { compatible?: boolean }).compatible, false);

  console.log('team client capabilities tests passed');
} finally {
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
