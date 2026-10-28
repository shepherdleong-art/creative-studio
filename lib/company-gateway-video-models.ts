/** Official model limits + company Tencent passthrough; see the 2026-10-28 integration record. */
export function companyNativeVideoModel(model: string) {
  switch (model) {
    case 'minimax-h3':
      return { minDurationSec: 4, maxDurationSec: 15, resolution: '2K', resolutions: ['768P', '2K'],
        aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        referenceImageCount: 9, referenceMediaCount: 3, referenceMinDurationSec: 2, referenceVideoMaxBytes: 50 * 1024 * 1024,
        explicitAspectRatios: null } as const;
    case 'wan-3.0':
      // Tencent rejects adaptive for Wan 3.0, even in first/last-frame mode.
      return { minDurationSec: 2, maxDurationSec: 30, resolution: '1080P', resolutions: ['480P', '720P', '1080P'],
        aspectRatios: ['16:9', '1:1', '3:4', '4:3', '9:16'],
        referenceImageCount: 10, referenceMediaCount: 5, referenceMinDurationSec: 1, referenceVideoMaxBytes: 100 * 1024 * 1024,
        explicitAspectRatios: ['16:9', '1:1', '3:4', '4:3', '9:16'] } as const;
    default:
      return null;
  }
}
