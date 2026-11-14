/** 只持久化固定分类，禁止记录异常正文、请求/响应或任意上游 code。 */
const FAILURE_HINTS = {
  transport_unknown: '',
  transport_connection_reset: '连接被重置',
  transport_connection_refused: '无法连接模型代理',
  transport_dns_failed: '模型服务地址解析失败',
  transport_socket_closed: '连接提前关闭',
  transport_response_incomplete: '响应接收中断',
  transport_timeout: '等待模型响应超时',
  transport_canceled: '请求被取消，结果待核查',
  llm_response_invalid_json: '模型服务返回了无效 JSON',
  llm_response_empty: '模型服务返回了空内容',
  llm_checkpoint_write_failed: '模型已返回，但结果保存失败',
} as const;

export type TransportFailureCode = keyof typeof FAILURE_HINTS;

export class ExecutionTransportFailure extends Error {
  readonly code: TransportFailureCode;
  constructor(code: TransportFailureCode, options?: ErrorOptions) {
    super(FAILURE_HINTS[code] || '调用结果未知', options);
    this.name = 'ExecutionTransportFailure';
    this.code = code;
  }
}

export function transportFailureHint(code: unknown): string {
  return typeof code === 'string' && Object.hasOwn(FAILURE_HINTS, code)
    ? FAILURE_HINTS[code as TransportFailureCode] : '';
}

export function transportFailureCode(error: unknown): TransportFailureCode {
  let cause = error;
  for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth++) {
    if (cause instanceof ExecutionTransportFailure) return cause.code;
    const current = cause as { code?: unknown; name?: unknown; cause?: unknown };
    switch (current.code) {
      case 'ECONNRESET': case 'EPIPE': return 'transport_connection_reset';
      case 'ECONNREFUSED': return 'transport_connection_refused';
      case 'ENOTFOUND': case 'EAI_AGAIN': return 'transport_dns_failed';
      case 'UND_ERR_SOCKET': return 'transport_socket_closed';
      case 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH': return 'transport_response_incomplete';
      case 'ETIMEDOUT': case 'UND_ERR_CONNECT_TIMEOUT': case 'UND_ERR_HEADERS_TIMEOUT':
      case 'UND_ERR_BODY_TIMEOUT': return 'transport_timeout';
    }
    if (current.name === 'TimeoutError') return 'transport_timeout';
    if (current.name === 'AbortError') return 'transport_canceled';
    cause = current.cause;
  }
  return 'transport_unknown';
}
