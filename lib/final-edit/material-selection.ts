export type MaterialSelectionByShotSet = Record<string, string[]>;

export function materialSelectionForShotSet(
  state: MaterialSelectionByShotSet,
  shotSetId: string | null | undefined,
): string[] {
  if (!shotSetId) return [];
  return state[shotSetId] ?? [];
}

export function initializeMaterialSelection(
  state: MaterialSelectionByShotSet,
  shotSetId: string,
  defaultMaterialKeys: string[],
  availableMaterialKeys: string[] = defaultMaterialKeys,
): MaterialSelectionByShotSet {
  const available = new Set(availableMaterialKeys);
  const hasUserSelection = Object.prototype.hasOwnProperty.call(state, shotSetId);
  const nextForShotSet = hasUserSelection
    ? (state[shotSetId] ?? []).filter((videoJobId) => available.has(videoJobId))
    : [...defaultMaterialKeys];

  if (
    hasUserSelection
    && nextForShotSet.length === (state[shotSetId] ?? []).length
    && nextForShotSet.every((videoJobId, index) => videoJobId === state[shotSetId]?.[index])
  ) return state;

  return { ...state, [shotSetId]: nextForShotSet };
}

export function toggleMaterialSelection(
  state: MaterialSelectionByShotSet,
  shotSetId: string,
  videoJobId: string,
): MaterialSelectionByShotSet {
  const current = materialSelectionForShotSet(state, shotSetId);
  return {
    ...state,
    [shotSetId]: current.includes(videoJobId)
      ? current.filter((id) => id !== videoJobId)
      : [...current, videoJobId],
  };
}
