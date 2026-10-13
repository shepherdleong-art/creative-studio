/** Compare with the browser-facing Host, since Next may rebuild request.url with localhost. */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  // Native local callers can omit Origin; endpoints still require their action header.
  if (origin === null) return true;
  try {
    const url = new URL(request.url);
    const host = request.headers.get('host') ?? url.host;
    if (!['http:', 'https:'].includes(url.protocol) || !host || /[\s,\/\\?#@]/.test(host)) return false;
    // Do not trust X-Forwarded-Host or treat all loopback hosts/ports as interchangeable.
    const expectedOrigin = new URL(`${url.protocol}//${host}`).origin;
    return new URL(origin).origin === origin && origin === expectedOrigin;
  } catch {
    return false;
  }
}
