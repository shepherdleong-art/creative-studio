export type BatchDomainErrorCode = 'not_found' | 'invalid_input' | 'conflict';

/** 批量领域公开 seam 的稳定错误协议；HTTP 层只按 code 映射，不比较中文文案。 */
export class BatchDomainError extends Error {
  readonly code: BatchDomainErrorCode;

  constructor(code: BatchDomainErrorCode, message: string) {
    super(message);
    this.name = 'BatchDomainError';
    this.code = code;
  }
}

/** 批量 API 在兼容模式(备份/锁/迁移门禁未通过)下整体不可用;HTTP 层映射 503。 */
export class BatchApiUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BatchApiUnavailableError';
    this.code = code;
  }
}
