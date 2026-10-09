/** 开跑自动重试有界；手动重试不受此限制。供服务端与进度展示共用。 */
export const SEMANTIC_SCORE_MAX_AUTO_ATTEMPTS = 3;

/** 只输出固定分类，不能把模型原文、凭据、URL 或提示词带入日志。 */
export function semanticScoreFailureHint(error: unknown): string {
  const record = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown; status?: unknown } : {};
  const message = typeof record.message === 'string' ? record.message : '';
  if (record.name === 'InvalidSemanticMatrixError') return '返回的矩阵维度或分数格式不符合要求';
  if (/无效.*json|invalid.*json/i.test(message)) return '模型返回的 JSON 无效或不完整';
  if (/空响应/.test(message)) return '模型返回空响应';
  if (/LiteLLM|本机健康检查/i.test(message)) return '本机 LiteLLM 代理不可用，请检查公司供应商连接';
  if (/API Key 未配置|provider_unconfigured/i.test(message)) return '供应商凭据未配置';
  const status = Number(record.status) || Number(message.match(/(?:HTTP|status|error)\s*[:=]?\s*(\d{3})/i)?.[1]);
  if (status === 401 || status === 403) return `供应商鉴权或访问被拒绝（HTTP ${status}）`;
  if (/额度不足|insufficient.quota/i.test(message)) return '供应商额度不足';
  if (status === 429 || /限流|rate.limit/i.test(message)) return '供应商限流或并发超限';
  if (/上下文长度超限|context.length/i.test(message)) return '请求上下文超限';
  if (/不支持的参数|参数.*不受支持/.test(message)) return '供应商不支持请求参数';
  if (/模型不存在|没有可用通道/.test(message)) return '模型不存在或上游没有可用通道';
  if (/内容审核拒绝/.test(message)) return '上游内容审核拒绝';
  if (record.name === 'TimeoutError' || /timeout|timed out|超时/i.test(message)) return '供应商请求超时';
  if (/fetch failed|connect|network|socket|ECONN/i.test(message)) return '供应商网络连接失败';
  if (status >= 400 && status <= 599) return `供应商请求失败（HTTP ${status}）`;
  return '供应商调用失败，未能识别具体原因';
}

export function semanticFallbackMessage(attemptNumber: number): string {
  return attemptNumber < SEMANTIC_SCORE_MAX_AUTO_ATTEMPTS
    ? 'AI 语义匹配暂不可用，开跑流程将自动重试；仍失败时使用关键词继续生产。'
    : 'AI 语义匹配未得到有效结果，已达自动尝试上限；后续将使用素材描述关键词继续生产。';
}
