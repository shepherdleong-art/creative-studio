import { sanitizeGatewayMediaDiagnostic } from './gateway-media-url.ts';
import { sanitizeMessage } from './log-sanitize.ts';

type ProviderDetail = { message: string; code?: string; param?: string };

/** 只提取错误字段，不把请求、鉴权或完整响应 JSON 带到界面。 */
function detailFrom(value: unknown, depth = 0): ProviderDetail | null {
  if (depth > 12) return null;
  if (value instanceof Error) return detailFrom(value.message, depth + 1);
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    // LiteLLM 的 message 常是“异常前缀 + JSON + 模型附言”，JSON 里又嵌套 JSON 字符串。
    const start = text.indexOf('{');
    if (start !== -1) {
      let braces = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') braces += 1;
        else if (char === '}' && --braces === 0) {
          try { return detailFrom(JSON.parse(text.slice(start, index + 1)), depth + 1); }
          catch { return null; }
        }
      }
      return null; // 残缺 JSON 不作为正文回显，避免泄漏请求字段。
    }
    if (/^\s*(?:<|\[)/.test(text)) return null;
    return { message: text };
  }
  if (Array.isArray(value)) {
    const details = value.slice(0, 3).map((item) => detailFrom(item, depth + 1)).filter((item) => item !== null);
    return details.length ? { message: details.map((item) => item.message).join('；') } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const code = typeof record.code === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(record.code)
    ? record.code : undefined;
  const param = typeof record.param === 'string' ? record.param : undefined;
  const fields = record.error && typeof record.error === 'object'
    ? ['error', 'message', 'msg', 'detail', 'error_description']
    : ['message', 'msg', 'detail', 'error_description', 'error'];
  for (const field of fields) {
    const nested = detailFrom(record[field], depth + 1);
    if (nested) return { ...nested, code: nested.code ?? code, param: nested.param ?? param };
  }
  return code ? { message: code, param } : null;
}

/** 展示用原因与提交状态分类分离；保留上游原文、错误码和参数，并在截断前脱敏。 */
export function providerErrorMessage(value: unknown, apiKey = ''): string | null {
  const detail = detailFrom(value);
  if (!detail) return null;
  const fields = [detail.message];
  if (detail.code && !detail.message.includes(detail.code)) fields.push(detail.code);
  if (detail.param && !detail.message.includes(detail.param)) fields.push(detail.param);
  const message = fields.map((field) => sanitizeMessage(sanitizeGatewayMediaDiagnostic(
    field.replace(/https?:\/\/[^\s<>"']+/gi, '[已隐藏地址]'), apiKey,
  ))
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|data|mnt)\/)[^\s<>"']+/g, '[已隐藏本地路径]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).filter(Boolean).join('；');
  return message ? message.slice(0, 800) : null;
}
