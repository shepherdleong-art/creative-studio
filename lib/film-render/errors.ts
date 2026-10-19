export class FilmRenderError extends Error {
  readonly code: string;
  readonly exitCode: 2 | 3 | 4;

  constructor(code: string, message: string, exitCode: 2 | 3 | 4 = 2) {
    super(message);
    this.name = 'FilmRenderError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function requireInput(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new FilmRenderError(code, message);
}
