import { NextResponse } from 'next/server';
import { gracefulShutdown } from '@/lib/shutdown';

const SHUTDOWN_TIMEOUT_MS = 12_000;

export async function POST() {
  const result = await gracefulShutdown({ timeoutMs: SHUTDOWN_TIMEOUT_MS });
  setTimeout(() => {
    process.exit(0);
  }, 100);

  return NextResponse.json({ message: '服务正在关闭...', ...result });
}
