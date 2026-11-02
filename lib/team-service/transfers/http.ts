import path from 'node:path';
import { dataRoot } from '../../data-root.ts';
import { ResourceAccessError } from '../resource-scopes.ts';
import { TransferError } from './errors.ts';

export function teamTransferStorageRoot(): string {
  return path.join(dataRoot(), 'storage');
}

export function teamTransferErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof TransferError || error instanceof ResourceAccessError) {
    return Response.json({
      error: error.code,
      message: error.message,
      ...(error instanceof TransferError ? error.details : undefined),
    }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
  }
  return Response.json({ error: fallback, message: '传输操作未完成，请稍后重试。' }, {
    status: 500,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export async function readTransferJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > 1024 * 1024) {
    throw new TransferError('invalid_input', '传输元数据不能超过 1 MiB。');
  }
  try {
    const value = await request.json() as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    throw new TransferError('invalid_input', '请求 JSON 无效。');
  }
}
