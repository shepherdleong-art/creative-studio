export function isExecutionDeferredError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'llm_execution_deferred'
    || (error as { code?: unknown } | null)?.code === 'media_resource_deferred';
}

export function isExecutionUnknownError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'llm_execution_unknown' || code === 'media_execution_unknown';
}

/** 等待准入与提交未知都不能进入业务降级、失败修复或免费重试。 */
export function isExecutionControlError(error: unknown): boolean {
  return isExecutionDeferredError(error) || isExecutionUnknownError(error);
}
