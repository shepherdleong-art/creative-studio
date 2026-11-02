import { gracefulShutdown } from '../../../lib/shutdown.ts';
import { readRuntimeConfig } from '../../../lib/team-service/config.ts';

const SHUTDOWN_TIMEOUT_MS = 12_000;

export async function POST() {
  if (readRuntimeConfig().mode === 'server') {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  const result = await gracefulShutdown({ timeoutMs: SHUTDOWN_TIMEOUT_MS });
  setTimeout(() => {
    process.exit(0);
  }, 100);

  return Response.json({ message: '服务正在关闭...', ...result });
}
