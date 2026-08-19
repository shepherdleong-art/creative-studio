/**
 * Company gateway Kling 3.0 intelligent-storyboard contract.
 *
 * This is deliberately exact: direct Kling and similarly named gateway models
 * must never receive the company-only flag by accident.
 */
export const COMPANY_MULTI_SHOT_PROVIDER_TYPE = 'openai-video' as const;
export const COMPANY_MULTI_SHOT_MODEL = 'kling-3.0' as const;

export type StoredVideoMultiShot = 0 | 1 | null;

export function isCompanyKlingMultiShotTarget(
  providerType: unknown,
  model: unknown,
): boolean {
  return providerType === COMPANY_MULTI_SHOT_PROVIDER_TYPE
    && model === COMPANY_MULTI_SHOT_MODEL;
}

/**
 * Normalize an API/UI value for video_jobs.multiShot.
 *
 * The managed target defaults on; only an explicit boolean false turns it off.
 * Other provider/model combinations are intentionally stored as NULL so that
 * this opt-in cannot leak into a future adapter or a direct Kling request.
 */
export function normalizeVideoMultiShotForStorage(
  providerType: unknown,
  model: unknown,
  value: unknown,
): StoredVideoMultiShot {
  if (!isCompanyKlingMultiShotTarget(providerType, model)) return null;
  return value === false ? 0 : 1;
}

/** Map nullable SQLite storage to the optional adapter request field. */
export function videoMultiShotFromStorage(value: unknown): boolean | undefined {
  if (value === 1) return true;
  if (value === 0) return false;
  return undefined;
}

/**
 * The OpenAI-style company gateway defaults the exact Kling model on unless
 * the persisted job explicitly disabled it. This helper intentionally accepts
 * only the model because the adapter is selected by provider type upstream.
 */
export function shouldInjectCompanyKlingMultiShot(
  model: unknown,
  multiShot: unknown,
): boolean {
  return model === COMPANY_MULTI_SHOT_MODEL && multiShot !== false;
}
