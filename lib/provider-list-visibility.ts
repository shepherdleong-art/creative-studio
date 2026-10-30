// Retired presets remain in storage for historical projects/jobs, but are not offered.
const RETIRED_IMAGE_IDS = new Set([
  'packy-gpt-image-2', 'packy-nano-banana-2', 'packy-nano-banana-pro',
  'gptge-gpt-image-2', 'gptge-nano-banana-2-2k', 'gptge-nano-banana-pro-2k',
  'ark-seedream-5-0-pro',
]);

export function isVisibleImageProvider(provider: { id: string; name: string; type: string; baseUrl: string }): boolean {
  return !RETIRED_IMAGE_IDS.has(provider.id)
    && !(provider.name === 'GeekAI' && provider.type === 'geekai-json' && provider.baseUrl.replace(/\/$/, '') === 'https://geekai.co/api');
}

export function isVisibleVideoProvider(provider: { id: string }): boolean {
  return provider.id !== 'jimeng-2-0' && provider.id !== 'kling-2-5';
}
