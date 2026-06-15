export interface ImageConcurrencyProvider {
  id?: string;
  name?: string;
  type?: string;
  baseUrl?: string;
}

function isPackyGeminiProvider(provider: ImageConcurrencyProvider): boolean {
  if (provider.type !== 'packy-gemini-image') return false;

  const identity = `${provider.id || ''} ${provider.name || ''} ${provider.baseUrl || ''}`.toLowerCase();
  return identity.includes('packy');
}

export function getEffectiveImageConcurrency(
  provider: string | ImageConcurrencyProvider,
  requestedConcurrency: number
): number {
  const requested = Number.isFinite(requestedConcurrency) ? Math.max(1, Math.floor(requestedConcurrency)) : 1;
  if (typeof provider === 'string') {
    if (provider === 'packy-gemini-image') return 1;
    return requested;
  }

  if (isPackyGeminiProvider(provider)) return 1;
  return requested;
}
