'use client';

export async function teamWrite(url: string, options: RequestInit = {}): Promise<Response> {
  const csrfResponse = await fetch('/api/team/auth/csrf', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!csrfResponse.ok) throw new Error('无法建立安全写入会话');
  const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
  const headers = new Headers(options.headers);
  headers.set('x-csrf-token', csrfToken);
  return fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
}

export async function teamError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}
