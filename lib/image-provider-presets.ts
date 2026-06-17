export type ImageProviderPreset = {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey: string;
  model: string;
  type: 'openai-compatible' | 'packy-images' | 'packy-gemini-image';
  enabled: 0 | 1;
  defaultCostPerImage: number;
};

export const GPTGE_GPT_IMAGE_2_PROVIDER: ImageProviderPreset = {
  id: 'gptge-gpt-image-2',
  name: 'GPT.ge GPT-Image-2',
  baseUrl: 'https://api.gpt.ge',
  apiKeyEnv: 'GPTGE_API_KEY',
  apiKey: '',
  model: 'gpt-image-2',
  type: 'openai-compatible',
  enabled: 0,
  defaultCostPerImage: 0.12,
};

export const DEFAULT_IMAGE_PROVIDER_PRESETS: ImageProviderPreset[] = [
  GPTGE_GPT_IMAGE_2_PROVIDER,
];
