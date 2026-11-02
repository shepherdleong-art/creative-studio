export type TeamTransferErrorCode =
  | 'invalid_input'
  | 'invalid_relative_name'
  | 'idempotency_conflict'
  | 'upload_not_found'
  | 'upload_cancelled'
  | 'upload_validating'
  | 'upload_interrupted'
  | 'invalid_part'
  | 'part_size_mismatch'
  | 'part_conflict'
  | 'missing_parts'
  | 'source_changed'
  | 'media_type_mismatch'
  | 'insufficient_storage'
  | 'publish_conflict'
  | 'device_not_found'
  | 'download_not_found'
  | 'receipt_conflict';

export class TransferError extends Error {
  readonly code: TeamTransferErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: TeamTransferErrorCode,
    message: string,
    status = defaultStatus(code),
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function defaultStatus(code: TeamTransferErrorCode): number {
  if (code === 'upload_not_found' || code === 'device_not_found' || code === 'download_not_found') return 404;
  if (code === 'insufficient_storage') return 507;
  if (code === 'invalid_input' || code === 'invalid_relative_name' || code === 'invalid_part' || code === 'part_size_mismatch') return 400;
  if (code === 'media_type_mismatch') return 422;
  return 409;
}

export function transferError(error: unknown): TransferError {
  if (error instanceof TransferError) return error;
  if ((error as NodeJS.ErrnoException | null)?.code === 'ENOSPC') {
    return new TransferError('insufficient_storage', '可用存储空间不足，请释放空间后重试。');
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ABORT_ERR'].includes(code ?? '')
    || (error as Error | null)?.name === 'AbortError') {
    return new TransferError('upload_interrupted', '分片传输已中断，请重试同一分片。');
  }
  return new TransferError('publish_conflict', '文件发布未完成，请重试。', 409);
}
