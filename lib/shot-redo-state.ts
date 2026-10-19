export interface RedoShotStateSource {
  id: string;
  sourceImageId: string;
  latestJobId?: string | null;
  referenceImageIds?: string | null;
  providerId?: string | null;
  jobPrompt?: string | null;
}

export interface RedoFormDefaults {
  inputSource: 'original' | 'current_result';
  referenceIds: string[];
  providerId: string;
  prompt: string;
}

export function getRedoInitKey(setId: string | null | undefined, shot: RedoShotStateSource | undefined): string {
  if (!setId || !shot) return '';
  return `${setId}:${shot.id}:${shot.latestJobId || ''}`;
}

export function shouldInitializeRedoForm(lastInitKey: string, nextInitKey: string): boolean {
  return !!nextInitKey && lastInitKey !== nextInitKey;
}

export function parseRedoReferenceIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function getRedoFormDefaults(
  shot: RedoShotStateSource,
  fallbackProviderId: string
): RedoFormDefaults {
  return {
    inputSource: 'original',
    referenceIds: parseRedoReferenceIds(shot.referenceImageIds).filter((id) => id !== shot.sourceImageId),
    providerId: shot.providerId || fallbackProviderId || '',
    prompt: shot.jobPrompt || '',
  };
}
