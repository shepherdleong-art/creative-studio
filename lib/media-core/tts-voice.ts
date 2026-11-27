export interface TtsVoice {
  id: string;
  label: string;
  previewUrl?: string;
}

export function defaultTtsVoice(provider: {
  voices: readonly TtsVoice[];
  defaultVoice?: string;
} | null | undefined): string {
  return provider?.defaultVoice ?? provider?.voices[0]?.id ?? '';
}
