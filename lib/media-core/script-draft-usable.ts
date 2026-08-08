/** V2 and V3 are both first-class Mixcut inputs; older rows stay on legacy read paths. */
export function isUsableMixcutScriptDraft(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const value = parsed as Record<string, unknown>;
  return (value.version === 2 || value.version === 3)
    && typeof value.shotSetId === 'string'
    && value.shotSetId.length > 0
    && Array.isArray(value.segments)
    && value.segments.length > 0;
}
