/** 画布统一错误类型与 HTTP 状态映射（技术约定 C7）。 */

export type CanvasErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'forbidden'
  | 'canvas_disabled'
  | 'canvas_unavailable'
  | 'runtime_unavailable'
  | 'capability_unavailable'
  | 'submission_uncertain';

export class CanvasError extends Error {
  readonly code: CanvasErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: CanvasErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
    this.details = details;
  }
}

export function canvasErrorStatus(code: CanvasErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'invalid_input':
      return 400;
    case 'forbidden':
      return 403;
    case 'conflict':
    case 'capability_unavailable':
    case 'submission_uncertain':
      return 409;
    case 'canvas_disabled':
    case 'canvas_unavailable':
    case 'runtime_unavailable':
      return 503;
    default:
      return 500;
  }
}
