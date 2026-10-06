import { NextResponse } from 'next/server';
import { ensureCanvasCapabilitiesRegistered } from './capabilities-bootstrap.ts';
import { getDb } from '../db.ts';
import { canvasFeatureEnabled } from './config.ts';
import { CanvasError, canvasErrorStatus } from './errors.ts';
import { CanvasGraphError } from './graph.ts';
import { getCanvasReadiness, canvasReadinessUnavailable } from './runtime-readiness.ts';

/**
 * 画布 API 统一前置检查：功能开关 → readiness（含迁移）。
 * 服务端强制，不依赖界面隐藏按钮。开关关闭时这里在触碰画布表之前就结束。
 */
export async function assertCanvasApiReady(): Promise<void> {
  if (!canvasFeatureEnabled()) {
    throw new CanvasError('canvas_disabled', '创作画布功能未开启。');
  }
  const readiness = await getCanvasReadiness();
  const unavailable = canvasReadinessUnavailable(readiness);
  if (unavailable) {
    throw new CanvasError('canvas_unavailable', unavailable.message, { reason: unavailable.code });
  }
  ensureCanvasCapabilitiesRegistered(getDb());
}

export function canvasErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof CanvasError) {
    return {
      status: canvasErrorStatus(error.code),
      body: { error: error.code, message: error.message, ...(error.details ?? {}) },
    };
  }
  // 图结构问题属于「无效输入」，但保留精确原因（self_loop / cycle / runtime_field_not_writable…）
  if (error instanceof CanvasGraphError) {
    return { status: 400, body: { error: error.code, message: error.message } };
  }
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const code = String((error as { code: unknown }).code);
    if (code === 'not_found' || code === 'invalid_input' || code === 'conflict') {
      return {
        status: canvasErrorStatus(code),
        body: { error: code, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
  return { status: 500, body: { error: 'canvas_error', message: error instanceof Error ? error.message : String(error) } };
}

export function canvasJsonError(error: unknown): NextResponse {
  const { status, body } = canvasErrorResponse(error);
  return NextResponse.json(body, { status });
}

export async function readCanvasJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CanvasError('invalid_input', '请求体必须是 JSON 对象。');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CanvasError) throw error;
    throw new CanvasError('invalid_input', '请求体不是合法的 JSON。');
  }
}
