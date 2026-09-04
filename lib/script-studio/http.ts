import { NextResponse } from 'next/server';
import { ScriptStudioApiUnavailableError } from './errors.ts';
import { getScriptStudioLimits } from './limits.ts';
import {
  getScriptStudioReadiness,
  scriptStudioReadinessUnavailable,
} from './runtime-readiness.ts';

export async function assertScriptStudioApiReady(): Promise<void> {
  const readiness = await getScriptStudioReadiness();
  const unavailable = scriptStudioReadinessUnavailable(readiness);
  if (unavailable) {
    throw new ScriptStudioApiUnavailableError(unavailable.code, unavailable.message);
  }
}

export function unavailableResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ScriptStudioApiUnavailableError) {
    return { status: 503, body: { error: error.code, message: error.message } };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
}

export function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ScriptStudioApiUnavailableError) {
    return { status: 503, body: { error: error.code, message: error.message } };
  }
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'script_studio_error';
  const message = error instanceof Error ? error.message : String(error);
  const status = code === 'not_found' ? 404
    : code === 'invalid_input' || code === 'resource_limit' ? 400
      : code === 'conflict' ? 409
        : code === 'provider_unavailable' || code === 'unavailable' ? 503
          : 500;
  return { status, body: { error: code, message } };
}

export async function jsonOrNull(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * 目录导入路由共用的上传读取与校验（方案 §6.1）：仅 .xlsx、大小上限内。
 * 只做表单层校验；ZIP/OOXML 内容校验在 catalog-import 的 assertXlsxBuffer。
 */
export async function readCatalogImportUpload(request: Request): Promise<{ file: File } | { error: NextResponse }> {
  let file: File | null = null;
  try {
    const formData = await request.formData();
    file = formData.get('file') instanceof File ? formData.get('file') as File : null;
  } catch {
    file = null;
  }
  if (!file) {
    return { error: NextResponse.json({ error: 'invalid_input', message: '缺少上传文件' }, { status: 400 }) };
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return { error: NextResponse.json({ error: 'invalid_input', message: '只接受 .xlsx 文件' }, { status: 400 }) };
  }
  const maxBytes = getScriptStudioLimits().maxCatalogImportBytes;
  if (file.size > maxBytes) {
    return { error: NextResponse.json({ error: 'invalid_input', message: `文件超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限` }, { status: 400 }) };
  }
  return { file };
}
