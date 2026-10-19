export interface ImageConcurrencyProvider {
  id?: string;
  name?: string;
  type?: string;
  baseUrl?: string;
}

export function getEffectiveImageConcurrency(
  provider: string | ImageConcurrencyProvider,
  requestedConcurrency: number
): number {
  const requested = Number.isFinite(requestedConcurrency) ? Math.max(1, Math.floor(requestedConcurrency)) : 1;
  return requested;
}
