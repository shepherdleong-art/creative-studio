export type ScriptStudioErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'unavailable'
  | 'provider_unavailable'
  | 'resource_limit'
  | 'evidence_failed'
  | 'evidence_insufficient';

export class ScriptStudioError extends Error {
  readonly code: ScriptStudioErrorCode;

  constructor(code: ScriptStudioErrorCode, message: string) {
    super(message);
    this.name = 'ScriptStudioError';
    this.code = code;
  }
}

export class ScriptStudioApiUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScriptStudioApiUnavailableError';
    this.code = code;
  }
}
