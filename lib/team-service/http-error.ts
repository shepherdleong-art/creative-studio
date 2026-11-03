export function teamServiceError(error: unknown, fallback = '团队服务暂时不可用。'): Response {
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };
    const explicitStatus = typeof value.status === 'number' ? value.status : null;
    const executionError = value.name === 'ExecutionError';
    const safePublicError = explicitStatus !== null || executionError;
    const code = safePublicError && typeof value.code === 'string' ? value.code : 'internal_error';
    const status = explicitStatus ?? (executionError ? (/version_conflict|settle_conflict/.test(code) ? 409 : 400) : 500);
    return Response.json({
      error: code,
      message: safePublicError && typeof value.message === 'string' ? value.message : fallback,
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json({ error: 'internal_error', message: fallback }, {
    status: 500,
    headers: { 'Cache-Control': 'no-store' },
  });
}
