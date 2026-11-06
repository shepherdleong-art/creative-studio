import { TransferError } from './errors.ts';

export interface TeamImageOptions {
  role: 'input' | 'reference';
  usage: string;
  preprocessEnabled: boolean;
  targetMaxSide: number;
  jpegQuality: number;
}

export function normalizeTeamImageOptions(value: unknown): TeamImageOptions | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TransferError('invalid_input', '图片上传选项无效。');
  const options = value as Record<string, unknown>;
  const role = options.role ?? 'input';
  const usage = options.usage ?? '';
  const preprocessEnabled = options.preprocessEnabled ?? true;
  const targetMaxSide = options.targetMaxSide ?? 1536;
  const jpegQuality = options.jpegQuality ?? 85;
  if (!['input', 'reference'].includes(String(role))
    || !['', 'scene_seed', 'shot_source', 'video_source', 'detail_page', 'video_tail_frame'].includes(String(usage))
    || typeof preprocessEnabled !== 'boolean'
    || typeof targetMaxSide !== 'number' || !Number.isInteger(targetMaxSide) || targetMaxSide < 64 || targetMaxSide > 8192
    || typeof jpegQuality !== 'number' || !Number.isInteger(jpegQuality) || jpegQuality < 1 || jpegQuality > 100
    || (usage === 'video_tail_frame' && role !== 'input')) {
    throw new TransferError('invalid_input', '图片角色、用途或预处理参数无效。');
  }
  return { role: role as TeamImageOptions['role'], usage: usage as string, preprocessEnabled, targetMaxSide, jpegQuality };
}
