/**
 * GPT-Image-2 size presets — synced with ComfyUI jkzf-GPTImage2 node.
 * Source: /Users/liangpeijian/Documents/ComfyUI/custom_nodes/jkzf-GPTImage2/gpt_image2_nodes.py
 */

export const GPT_IMAGE_2_ASPECT_RATIOS = [
  'auto',
  '1:1',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
  '5:4',
  '4:5',
  '16:9',
  '9:16',
  '2:1',
  '1:2',
  '21:9',
  '9:21',
] as const;

export const GPT_IMAGE_2_RESOLUTIONS = ['1k', '2k', '4k'] as const;

export type AspectRatio = (typeof GPT_IMAGE_2_ASPECT_RATIOS)[number];
export type Resolution = (typeof GPT_IMAGE_2_RESOLUTIONS)[number];

/**
 * Exact SIZE_MAP from ComfyUI node.
 * Key: (aspectRatio, resolution) → size string.
 */
export const GPT_IMAGE_2_SIZE_MAP: Record<string, Record<string, string>> = {
  '1:1':  { '1k': '1024x1024', '2k': '2048x2048', '4k': '2880x2880' },
  '3:2':  { '1k': '1248x832',  '2k': '2496x1664', '4k': '3504x2336' },
  '2:3':  { '1k': '832x1248',  '2k': '1664x2496', '4k': '2336x3504' },
  '4:3':  { '1k': '1152x864',  '2k': '2304x1728', '4k': '3264x2448' },
  '3:4':  { '1k': '864x1152',  '2k': '1728x2304', '4k': '2448x3264' },
  '5:4':  { '1k': '1120x896',  '2k': '2240x1792', '4k': '3200x2560' },
  '4:5':  { '1k': '896x1120',  '2k': '1792x2240', '4k': '2560x3200' },
  '16:9': { '1k': '1280x720',  '2k': '2560x1440', '4k': '3840x2160' },
  '9:16': { '1k': '720x1280',  '2k': '1440x2560', '4k': '2160x3840' },
  '2:1':  { '1k': '2048x1024', '2k': '2688x1344', '4k': '3840x1920' },
  '1:2':  { '1k': '1024x2048', '2k': '1344x2688', '4k': '1920x3840' },
  '21:9': { '1k': '1456x624',  '2k': '3024x1296', '4k': '3696x1584' },
  '9:21': { '1k': '624x1456',  '2k': '1296x3024', '4k': '1584x3696' },
};

/** Resolve a GPT-Image-2 size from aspect ratio and resolution. Throws on invalid combination. */
export function resolveGptImage2Size(aspectRatio: string, resolution: string): string {
  if (aspectRatio === 'auto') return 'auto';
  const size = GPT_IMAGE_2_SIZE_MAP[aspectRatio]?.[resolution];
  if (!size) {
    throw new Error(`Unsupported GPT-Image-2 size: ${aspectRatio} ${resolution}`);
  }
  return size;
}

/** Check whether a raw size string is in the valid SIZE_MAP. */
export function isValidGptImage2Size(size: string): boolean {
  if (size === 'auto') return true;
  return Object.values(GPT_IMAGE_2_SIZE_MAP).some((byRes) =>
    Object.values(byRes).includes(size)
  );
}
