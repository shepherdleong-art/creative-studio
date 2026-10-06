/** Exact Ark model contracts. Company channels must use separately verified gateway rules. */
export const SEEDANCE_20 = 'doubao-seedance-2-0-260128';
export const SEEDANCE_25 = 'doubao-seedance-2-5-260628';
export const SEEDANCE_FAST = 'doubao-seedance-2-0-fast-260128';
export const SEEDANCE_MINI = 'doubao-seedance-2-0-mini-260128';

export interface SeedanceOutputOptions {
  resolution?: string;
  generateAudio?: boolean;
  outputFormat?: 'mp4' | 'mov';
  watermark?: boolean;
  returnLastFrame?: boolean;
  draft?: boolean;
}

export class SeedanceRequestError extends Error {}
export function seedanceContract(model: string) {
  if (model === SEEDANCE_25) return { maxDuration: 30, imageCount: 30, mediaCount: 10, resolutions: ['480p', '720p', '1080p'], draft: true };
  if (model === SEEDANCE_20) return { maxDuration: 15, imageCount: 9, mediaCount: 3, resolutions: ['480p', '720p', '1080p', '4k'], draft: false };
  if (model === SEEDANCE_FAST || model === SEEDANCE_MINI) return { maxDuration: 15, imageCount: 9, mediaCount: 3, resolutions: ['480p', '720p'], draft: false };
  return null;
}

/** Missing options retain the old adapter's behavior. Explicit new options are checked. */
export function seedanceOutputFields(model: string, options: SeedanceOutputOptions): Record<string, unknown> {
  const contract = seedanceContract(model);
  if (options.draft && !contract?.draft) throw new SeedanceRequestError('该型号不支持样片');
  const resolution = options.resolution ?? (options.draft ? '480p' : model === SEEDANCE_FAST || model === SEEDANCE_MINI ? '720p' : '1080p');
  if (contract && !contract.resolutions.includes(resolution)) throw new SeedanceRequestError('该型号不支持所选分辨率');
  if (options.draft && resolution !== '480p') throw new SeedanceRequestError('样片只能使用 480p');
  if (options.outputFormat === 'mov' && model !== SEEDANCE_25) throw new SeedanceRequestError('该型号不支持 MOV');
  return {
    resolution,
    watermark: options.watermark ?? false,
    generate_audio: options.generateAudio ?? true,
    ...(options.outputFormat !== undefined ? { output_format: options.outputFormat } : {}),
    ...(options.returnLastFrame !== undefined ? { return_last_frame: options.returnLastFrame } : {}),
    ...(options.draft !== undefined ? { draft: options.draft } : {}),
  };
}

export function assertArkRequestSize(body: Record<string, unknown>): string {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024 * 1024) {
    throw new SeedanceRequestError('请求体超过 64 MB，请配置 COS 交付图片后重试');
  }
  return serialized;
}

/** Final-from-Draft has its own whitelist: never merge ordinary creation defaults. */
export function seedanceFinalBody(request: {
  model: string; draftTaskId: string; outputFormat?: 'mp4' | 'mov'; watermark?: boolean; returnLastFrame?: boolean;
}): Record<string, unknown> {
  if (request.model !== SEEDANCE_25 || !request.draftTaskId.trim()) throw new SeedanceRequestError('正式转化必须选择有效的 Seedance 2.5 样片');
  return {
    model: request.model,
    content: [{ type: 'draft_task', draft_task: { id: request.draftTaskId } }],
    resolution: '1080p',
    ...(request.outputFormat !== undefined ? { output_format: request.outputFormat } : {}),
    ...(request.watermark !== undefined ? { watermark: request.watermark } : {}),
    ...(request.returnLastFrame !== undefined ? { return_last_frame: request.returnLastFrame } : {}),
  };
}
