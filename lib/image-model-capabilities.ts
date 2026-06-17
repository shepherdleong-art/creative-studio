export interface ImageModelCapabilities {
  model: string;
  label: string;
  supportsQuality: boolean;
  recommendedTimeoutMs: number;
}

export const PACKY_IMAGE_MODEL_OPTIONS: ImageModelCapabilities[] = [
  {
    model: 'gpt-image-2',
    label: 'GPT-Image-2',
    supportsQuality: true,
    recommendedTimeoutMs: 600000,
  },
  {
    model: 'gemini-3.1-flash-image-preview',
    label: 'Nano Banana 2',
    supportsQuality: false,
    recommendedTimeoutMs: 600000,
  },
  {
    model: 'gemini-3.1-flash-image-2k',
    label: 'Nano Banana 2 2K',
    supportsQuality: false,
    recommendedTimeoutMs: 600000,
  },
  {
    model: 'gemini-3-pro-image-preview',
    label: 'Nano Banana Pro',
    supportsQuality: false,
    recommendedTimeoutMs: 600000,
  },
  {
    model: 'gemini-3-pro-image-2k',
    label: 'Nano Banana Pro 2K',
    supportsQuality: false,
    recommendedTimeoutMs: 600000,
  },
];

const DEFAULT_CAPABILITIES: ImageModelCapabilities = {
  model: '',
  label: '自定义模型',
  supportsQuality: true,
  recommendedTimeoutMs: 600000,
};

export function getImageModelCapabilities(model: string): ImageModelCapabilities {
  return PACKY_IMAGE_MODEL_OPTIONS.find((option) => option.model === model) || {
    ...DEFAULT_CAPABILITIES,
    model,
  };
}

export function imageModelSupportsQuality(model: string): boolean {
  return getImageModelCapabilities(model).supportsQuality;
}
