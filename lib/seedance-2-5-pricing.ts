/** 火山方舟刊例价（2026-11-12 确认）：样片和转高清分别计费，互不抵扣。
 * https://docs.volcengine.com/docs/ark/model-pricing?lang=zh
 */
export const SEEDANCE_25_STAGE_PRICING_VERSION = 'seedance-2-5-ark-2026-11-12';

export interface Seedance25StagePricing {
  generationStage: 'draft' | 'final-from-draft';
  /** 转高清沿用原样片是否包含视频参考，样片本身不算视频参考。 */
  hasInputVideo: boolean;
}

export const SEEDANCE_25_STAGE_TOKEN_PRICES = Object.freeze({
  draft: Object.freeze({ withoutVideo: 70_000_000, withVideo: 42_000_000 }),
  'final-from-draft': Object.freeze({ withoutVideo: 77_000_000, withVideo: 46_000_000 }),
});

/** 官方像素表，24 fps；用于预估，实际用量以 completion_tokens 为准。
 * https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh
 */
const OUTPUT_SIZES: Record<Seedance25StagePricing['generationStage'], Record<string, readonly [number, number]>> = {
  draft: {
    '16:9': [854, 480], '4:3': [752, 560], '1:1': [640, 640],
    '3:4': [560, 752], '9:16': [480, 854], '21:9': [992, 432],
  },
  'final-from-draft': {
    '16:9': [1920, 1080], '4:3': [1664, 1248], '1:1': [1440, 1440],
    '3:4': [1248, 1664], '9:16': [1080, 1920], '21:9': [2206, 946],
  },
};

export function seedance25StageOutputSize(
  stage: Seedance25StagePricing['generationStage'],
  aspectRatio: string,
): readonly [number, number] | null {
  return Object.hasOwn(OUTPUT_SIZES[stage], aspectRatio) ? OUTPUT_SIZES[stage][aspectRatio] : null;
}

export function estimateSeedance25VideoTokens(durationSec: number, width: number, height: number): number | null {
  if (![durationSec, width, height].every((value) => Number.isFinite(value) && value > 0)) return null;
  return durationSec * width * height * 24 / 1024;
}

/** 官方最低用量表的公式：含输入视频时，最低参考时长为 ceil(输出秒数 × 2/3)。
 * https://bytedance.larkoffice.com/wiki/FXaYwxzJ5i5Zdik32ipcWzt7nxd?table=tblheIYDXXwYM43b&view=vew2CR2JYM
 */
export const SEEDANCE_25_MINIMUM_TOKEN_RULE_VERSION = 'seedance-2-5-video-minimum-2026-11-12';

export interface Seedance25ReferenceVideoTokenEstimate {
  estimatedTokens: number;
  minimumTokens: number;
  billableTokens: number;
  minimumInputVideoDurationSec: number;
}

export function estimateSeedance25ReferenceVideoTokens(
  outputDurationSec: number,
  inputVideoDurationSec: number,
  width: number,
  height: number,
): Seedance25ReferenceVideoTokenEstimate | null {
  if (![outputDurationSec, inputVideoDurationSec, width, height]
    .every((value) => Number.isFinite(value) && value > 0)) return null;
  const minimumInputVideoDurationSec = Math.ceil(outputDurationSec * 2 / 3);
  const estimatedTokens = estimateSeedance25VideoTokens(outputDurationSec + inputVideoDurationSec, width, height);
  const minimumTokens = estimateSeedance25VideoTokens(outputDurationSec + minimumInputVideoDurationSec, width, height);
  if (estimatedTokens === null || minimumTokens === null) return null;
  const billableTokens = Math.max(estimatedTokens, minimumTokens);
  if (!Number.isFinite(billableTokens)) return null;
  return { estimatedTokens, minimumTokens, billableTokens, minimumInputVideoDurationSec };
}
