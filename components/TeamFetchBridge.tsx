'use client';

import { useEffect } from 'react';

let csrfToken: string | null = null;
let csrfPromise: Promise<string> | null = null;

export default function TeamFetchBridge() {
  useEffect(() => {
    if (document.documentElement.dataset.deploymentMode !== 'server') return;
    const originalFetch = window.fetch.bind(window);
    const tokenForWrite = async (): Promise<string> => {
      if (csrfToken) return csrfToken;
      csrfPromise ??= originalFetch('/api/team/auth/csrf', { credentials: 'same-origin' })
        .then(async (response) => {
          if (!response.ok) throw new Error('CSRF 初始化失败');
          const body = await response.json() as { csrfToken?: string };
          if (!body.csrfToken) throw new Error('CSRF 初始化失败');
          csrfToken = body.csrfToken;
          return csrfToken;
        })
        .finally(() => { csrfPromise = null; });
      return csrfPromise;
    };

    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url, window.location.origin);
      const method = request.method.toUpperCase();
      const needsCsrf = url.origin === window.location.origin
        && url.pathname.startsWith('/api/')
        && !['GET', 'HEAD', 'OPTIONS'].includes(method)
        && url.pathname !== '/api/team/auth/csrf';
      const headers = new Headers(request.headers);
      if (needsCsrf && !headers.has('x-csrf-token')) headers.set('x-csrf-token', await tokenForWrite());
      const response = await originalFetch(input, {
        ...init,
        headers,
        credentials: init?.credentials ?? 'same-origin',
      });
      if (response.status === 401 && url.pathname !== '/api/team/auth/login' && url.pathname !== '/api/team/auth/session') {
        csrfToken = null;
        const next = `${window.location.pathname}${window.location.search}`;
        if (window.location.pathname !== '/team/login') window.location.assign(`/team/login?next=${encodeURIComponent(next)}`);
      }
      return response;
    };
    return () => { window.fetch = originalFetch; };
  }, []);
  return null;
}
