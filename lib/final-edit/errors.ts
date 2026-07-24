export class FinalEditError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'FinalEditError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
