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
