/** V2 和 V3 都是可用的 Mixcut 输入；可见性交给 script-visibility，不在这里做 shotSetId 过滤。 */
export function isUsableMixcutScriptDraft(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const value = parsed as Record<string, unknown>;
  return (value.version === 2 || value.version === 3)
    && Array.isArray(value.segments)
    && value.segments.length > 0;
}
