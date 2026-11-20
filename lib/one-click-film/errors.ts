/** 一键成片领域错误：路由统一映射到 4xx/5xx，不把内部堆栈透给客户端。 */
export class OneClickFilmError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OneClickFilmError';
    this.code = code;
    this.status = status;
  }
}

export class OneClickFilmUnavailableError extends OneClickFilmError {
  constructor(code: string, message: string) {
    super(code, message, 503);
    this.name = 'OneClickFilmUnavailableError';
  }
}
