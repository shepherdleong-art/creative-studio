/**
 * 网关结果 URL 归一化与下载。
 *
 * 背景：New API 类网关未配置「服务器地址」时，任务完成后 metadata.url 会返回
 * http://localhost:3000/v1/videos/<task>/content 这种指向网关自身、但主机名是
 * localhost 的地址——直接当公网 URL 下载会打到我们自己本机。这里把 localhost /
 * 相对路径一律改写到网关 origin；下载时仅当目标确实指向网关 origin 才附带
 * API Key，避免把密钥泄露给第三方 CDN。
 */

export function normalizeGatewayResultUrl(rawUrl: string | undefined, baseUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const gatewayOrigin = safeOrigin(baseUrl);
  if (!gatewayOrigin) return rawUrl;

  // 相对路径：直接挂到网关 origin 下
  if (rawUrl.startsWith('/')) {
    return `${gatewayOrigin}${rawUrl}`;
  }

  try {
    const parsed = new URL(rawUrl);
    const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
    if (isLoopback) {
      return `${gatewayOrigin}${parsed.pathname}${parsed.search}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/** 目标 URL 是否指向网关自身（只有这种情况下载才需要带 API Key）。 */
export function isGatewayOriginUrl(url: string, baseUrl: string): boolean {
  const gatewayOrigin = safeOrigin(baseUrl);
  if (!gatewayOrigin) return false;
  try {
    return new URL(url).origin === gatewayOrigin;
  } catch {
    return false;
  }
}

export type GatewayMediaDownloadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; status?: number; errorMessage: string };

const MAX_REDIRECTS = 5;
const MAX_ERROR_SUMMARY_LENGTH = 500;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 识别「HTTP 200 + JSON 错误体」：content-type 是 json，或 body 以 '{' 开头。
 * 命中时返回 error.message 文本，否则返回 null（按媒体字节处理）。
 * 真实媒体（JPEG/PNG/MP4 等）的首字节不会是 '{'，不会误判。
 */
function extractJsonErrorBody(contentType: string | null, buffer: Buffer): string | null {
  const isJsonContentType = !!contentType && /json/i.test(contentType);
  let text: string | null = null;
  if (isJsonContentType || buffer.subarray(0, 1).toString('utf8') === '{') {
    text = buffer.toString('utf8');
  }
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed?.error === 'string') return parsed.error;
    if (parsed?.error?.message) return parsed.error.message;
    if (parsed?.message) return parsed.message;
    return text;
  } catch {
    return isJsonContentType ? text : null;
  }
}

export async function downloadGatewayMedia(
  url: string,
  baseUrl: string,
  apiKey: string
): Promise<GatewayMediaDownloadResult> {
  let currentUrl = url;
  let redirectCount = 0;

  while (true) {
    const headers: Record<string, string> = {};
    if (isGatewayOriginUrl(currentUrl, baseUrl) && apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(currentUrl, { headers, redirect: 'manual' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const summary = sanitizeGatewayMediaDiagnostic(detail, apiKey).slice(0, MAX_ERROR_SUMMARY_LENGTH);
      return {
        ok: false,
        errorMessage: `Network error downloading ${sanitizeGatewayMediaDiagnostic(redactMediaUrlForLog(currentUrl), apiKey)}${summary ? `: ${summary}` : ''}`,
      };
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirectCount >= MAX_REDIRECTS) {
        return {
          ok: false,
          status: response.status,
          errorMessage: `HTTP ${response.status}: redirect limit (${MAX_REDIRECTS}) exceeded`,
        };
      }

      const location = response.headers.get('location');
      if (!location) {
        return {
          ok: false,
          status: response.status,
          errorMessage: `HTTP ${response.status}: redirect response missing Location header`,
        };
      }

      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return {
          ok: false,
          status: response.status,
          errorMessage: `HTTP ${response.status}: invalid redirect target`,
        };
      }
      redirectCount += 1;
      continue;
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        // The HTTP status remains useful even when the response body cannot be read.
      }
      const summary = sanitizeGatewayMediaDiagnostic(body, apiKey)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_ERROR_SUMMARY_LENGTH);
      return {
        ok: false,
        status: response.status,
        errorMessage: `HTTP ${response.status}${summary ? `: ${summary}` : ''}`,
      };
    }

    try {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      // 网关/LiteLLM 有时用 HTTP 200 包着 JSON 错误体返回（例如 SSRF 拦截
      // localhost:3000 结果地址时），不能把错误体当媒体字节交给下游。
      const jsonErrorMessage = extractJsonErrorBody(response.headers.get('content-type'), buffer);
      if (jsonErrorMessage) {
        const summary = sanitizeGatewayMediaDiagnostic(jsonErrorMessage, apiKey)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_ERROR_SUMMARY_LENGTH);
        return { ok: false, status: response.status, errorMessage: `Gateway returned JSON error body: ${summary}` };
      }
      return { ok: true, buffer };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const summary = sanitizeGatewayMediaDiagnostic(detail, apiKey).slice(0, MAX_ERROR_SUMMARY_LENGTH);
      return {
        ok: false,
        errorMessage: `Network error reading ${sanitizeGatewayMediaDiagnostic(redactMediaUrlForLog(currentUrl), apiKey)}${summary ? `: ${summary}` : ''}`,
      };
    }
  }
}

/** Keep enough of a media URL for diagnostics without logging signed query parameters or a known API key. */
export function redactMediaUrlForLog(url: string, apiKey = ''): string {
  try {
    const parsed = new URL(url);
    const redactedUrl = `${parsed.origin}${parsed.pathname}${parsed.search ? '?[query redacted]' : ''}`;
    return apiKey ? sanitizeGatewayMediaDiagnostic(redactedUrl, apiKey) : redactedUrl;
  } catch {
    return '[invalid media URL]';
  }
}

const SENSITIVE_MEDIA_KEYS = new Set(['token', 'access_token', 'api_key', 'signature']);

export function sanitizeGatewayMediaDiagnostic(value: string, apiKey = ''): string {
  let sanitized = redactJsonSecrets(value);
  sanitized = redactEmbeddedHttpUrlQueries(sanitized);
  if (apiKey) {
    sanitized = sanitized.replaceAll(apiKey, '[REDACTED]');
    const encodedApiKey = safeEncodeURIComponent(apiKey);
    if (encodedApiKey && encodedApiKey !== apiKey) {
      sanitized = sanitized.replace(
        new RegExp(escapeRegExp(encodedApiKey), 'gi'),
        '[REDACTED]',
      );
    }
  }
  sanitized = sanitized.replace(/\bBearer\s+[^\s,\x22\x27}]+/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(
    /([?&](?:token|access_token|api_key|signature)=)[^&#\s,\x22\x27}]*/gi,
    '$1[REDACTED]',
  );
  sanitized = sanitized.replace(
    /\b(token|access_token|api_key|signature)\s*=\s*[^\s&,\x22\x27}]+/gi,
    '$1=[REDACTED]',
  );
  return sanitized;
}

function safeEncodeURIComponent(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function redactEmbeddedHttpUrlQueries(value: string): string {
  return value.replace(
    /\bhttps?:\/\/[^?\s\x22\x27,]+\?(?!\[query redacted\]).*?(?=\s|[\x22\x27,]|$)/gi,
    (url) => `${url.slice(0, url.indexOf('?'))}?[query redacted]`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactJsonSecrets(value: string): string {
  try {
    return JSON.stringify(redactJsonValue(JSON.parse(value)));
  } catch {
    return value;
  }
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return redactEmbeddedHttpUrlQueries(value);
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      SENSITIVE_MEDIA_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactJsonValue(nestedValue),
    ]),
  );
}

function safeOrigin(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}
