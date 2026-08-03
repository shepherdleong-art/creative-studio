import { BatchApiUnavailableError, BatchDomainError } from './errors.ts';

export interface BatchHttpErrorFallback {
  error: string;
  message: string;
}

export interface BatchHttpErrorResult {
  status: number;
  body: { error: string; code?: string; message: string };
}

/**
 * 批量 API 统一错误映射:HTTP 层只按错误码映射状态码,不比较中文文案。
 * - BatchApiUnavailableError → 503(batch_api_unavailable)
 * - BatchDomainError not_found → 404;conflict → 409;invalid_input → 400
 * - 其他错误 → 500
 * 纯数据函数,可在 Node 测试中直接验证;route 层负责包成 NextResponse。
 */
export function batchErrorResponse(error: unknown, fallback: BatchHttpErrorFallback): BatchHttpErrorResult {
  if (error instanceof BatchApiUnavailableError) {
    return {
      status: 503,
      body: { error: 'batch_api_unavailable', code: error.code, message: error.message },
    };
  }
  if (error instanceof BatchDomainError) {
    let status: number;
    if (error.code === 'not_found') {
      status = 404;
    } else if (error.code === 'conflict') {
      status = 409;
    } else {
      status = 400;
    }
    return {
      status,
      body: { error: fallback.error, code: error.code, message: error.message },
    };
  }
  return {
    status: 500,
    // 未预期错误可能携带 FFmpeg stderr、本地绝对路径或 SQLite 细节；
    // 对客户端只返回 route 提供的安全文案，详细错误留在服务端边界处理。
    body: { error: fallback.error, message: fallback.message },
  };
}
