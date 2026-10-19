export function isTimeoutLikeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('abort') ||
    m.includes('aborted') ||
    m.includes('failed to fetch') ||
    m.includes('network')
  );
}

export function isNonRetryablePackyError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /^packy api error 4\d\d:/i.test(message) ||
    /^packy gemini returned non-json response 4\d\d:/i.test(message) ||
    m.includes('not supported model for image generation')
  );
}

export function getNonRetryablePackyAdvice(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('429') || m.includes('resource has been exhausted') || m.includes('quota')) {
    return 'Packy/Gemini 返回额度或限流错误，立即自动重试大概率仍会失败；已停止自动重试。请等待额度恢复或检查 Packy 控制台后手动重跑。';
  }
  if (m.includes('not supported model for image generation')) {
    return 'Packy 返回模型/端点不匹配错误，自动重试不会成功；已停止自动重试。请切换模型或供应商配置后手动重跑。';
  }
  return 'Packy 返回 4xx 参数/请求错误，自动重试不会成功；已停止自动重试。请根据错误调整参数后手动重跑。';
}
