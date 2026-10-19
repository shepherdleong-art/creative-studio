/**
 * Provider errors are persisted by callers. Only return locally defined labels;
 * upstream messages, arbitrary codes, URLs and echoed prompts must never escape.
 * A label describes what the upstream reports, not an independently proven cause.
 */
export function safeProviderErrorHint(body: string): string {
  let message = '';
  let code = '';
  let param = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      const error = root.error && typeof root.error === 'object' && !Array.isArray(root.error)
        ? root.error as Record<string, unknown>
        : root;
      message = typeof error.message === 'string' ? error.message : '';
      code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
      param = typeof error.param === 'string' ? error.param : '';
    }
  } catch {
    // Some compatible gateways return plain text instead of a JSON error.
    // HTML is deliberately excluded to avoid classifying proxy page content.
    if (!/^\s*</.test(body)) message = body;
  }

  if (code === 'context_length_exceeded' || /maximum context length|context[_ ](?:length|window).*(?:exceed|too long)|too many tokens/i.test(message)) {
    return '上下文长度超限';
  }
  if (['invalid_image_url', 'image_parse_error', 'invalid_image', 'image_too_large'].includes(code)
    || /(?:error|failed|unable|timeout|timed out).{0,80}(?:download|fetch|read|access).{0,40}image|(?:download|fetch).{0,40}image.{0,40}(?:failed|timeout|timed out)|invalid image(?: url)?|image.{0,30}(?:too large|unsupported format)/i.test(message)) {
    return '图片读取失败或图片格式、大小不受支持';
  }
  if (code === 'insufficient_quota' || /insufficient[_ ]quota|quota.{0,30}exceeded|insufficient balance/i.test(message)) {
    return '上游额度不足';
  }
  if (code === 'rate_limit_exceeded' || /rate[_ ]limit|too many requests|concurrency.{0,30}(?:limit|exceed)/i.test(message)) {
    return '上游限流或并发超限';
  }
  if (['content_policy_violation', 'content_filter', 'content_filter_error'].includes(code)
    || /content[_ ]policy[_ ]violation|content.{0,30}(?:blocked|rejected).{0,30}(?:safety|policy)|safety system/i.test(message)) {
    return '上游内容审核拒绝';
  }
  if (code === 'model_not_found' || /model.{0,60}(?:does not exist|not found)|no available (?:channel|deployment)/i.test(message)) {
    return '模型不存在或上游没有可用通道';
  }
  if (['unsupported_parameter', 'unsupported_value', 'invalid_parameter'].includes(code)
    || /unsupported (?:parameter|value)|does not support|not supported|invalid parameter/i.test(message)) {
    // Never echo a free-form upstream param, even if it resembles an identifier.
    const known = ['temperature', 'max_tokens', 'max_completion_tokens', 'response_format', 'stream_options', 'stream', 'top_p'];
    const field = known.find((name) => param === name)
      ?? known.find((name) => new RegExp(`\\b${name}\\b`, 'i').test(message));
    return field ? `不支持的参数：${field}，或该参数的值无效` : '请求参数或参数值不受支持';
  }
  if (code === 'invalid_api_key' || /invalid api key|incorrect api key|authentication failed/i.test(message)) {
    return '上游鉴权失败';
  }
  if (/timeout|timed out/i.test(message)) return '上游请求超时';
  return '上游未提供可安全识别的原因';
}
