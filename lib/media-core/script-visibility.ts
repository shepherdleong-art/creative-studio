export interface ScriptVisibilityInput {
  shotSetId: string | null | undefined;
  requestedShotSetId?: string | null;
  validShotSetIds?: ReadonlySet<string>;
}

/**
 * 项目脚本可见性统一闸门：
 * - 空 shotSetId 是项目级脚本，同一 projectId 内可见；
 * - 非空 shotSetId 的历史脚本仍保持原窄隔离（组被删除时不可见、请求指定组时必须匹配）；
 * - 未显式请求组时，非空历史脚本只要仍属于项目内的有效组即可读取，保持旧行为。
 */
export function isScriptVisibleInContext(input: ScriptVisibilityInput): boolean {
  const shotSetId = typeof input.shotSetId === 'string' ? input.shotSetId.trim() : '';
  if (!shotSetId) return true;
  if (input.validShotSetIds && !input.validShotSetIds.has(shotSetId)) return false;
  if (input.requestedShotSetId && input.requestedShotSetId !== shotSetId) return false;
  return true;
}

export function projectScriptShotSetIdFromParsed(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const candidate = value as { shotSetId?: unknown };
  return typeof candidate.shotSetId === 'string' ? candidate.shotSetId.trim() : '';
}
