import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function sourceApiRoutes(root) {
  return fs.readdirSync(path.join(root, 'app/api'), { recursive: true })
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => /\/route\.(?:ts|tsx|js|jsx)$/.test(file))
    .filter(file => !file.split('/').some(segment => segment.startsWith('_')))
    .map(file => '/api/' + file.replace(/\/route\.(?:ts|tsx|js|jsx)$/, '')
      .split('/').filter(segment => !/^\(.*\)$/.test(segment)).join('/'));
}

export function missingDevApiRoutes(root, routes = sourceApiRoutes(root)) {
  let declarations;
  try {
    declarations = fs.readFileSync(path.join(root, '.next/dev/types/routes.d.ts'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return routes;
    throw error;
  }
  const registered = new Set([...declarations.matchAll(/"(\/api[^"\n]*)"/g)].map(match => match[1]));
  return routes.filter(route => !registered.has(route));
}

// Next 16.2 can announce readiness with a partial initial Watchpack scan. A
// later app-directory event republishes the complete route table. Keep the
// workaround in the development launcher; never edit source or dependencies.
export async function ensureDevApiRoutes(root, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const routes = sourceApiRoutes(root);
  const deadline = Date.now() + timeoutMs;
  const marker = path.join(root, 'app', `.local-preview-route-scan-${randomUUID()}.tmp`);
  let missing = missingDevApiRoutes(root, routes);
  let nudged = false;
  try {
    while (missing.length && Date.now() < deadline) {
      fs.writeFileSync(marker, String(Date.now()));
      nudged = true;
      await delay(intervalMs);
      missing = missingDevApiRoutes(root, routes);
    }
    if (missing.length) {
      throw new Error(`预览路由扫描未完成，仍缺少 ${missing.length} 个接口：${missing.slice(0, 3).join('、')}`);
    }
    return { count: routes.length, recovered: nudged };
  } finally {
    if (nudged) fs.rmSync(marker, { force: true });
  }
}
