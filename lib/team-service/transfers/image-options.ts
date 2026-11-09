import { TransferError } from './errors.ts';
import type { ProductionDefaults } from '../production-defaults.ts';

export interface TeamImageOptions {
  role: 'input' | 'reference';
  usage: string;
  preprocessEnabled: boolean;
  targetMaxSide: number;
  jpegQuality: number;
}

/**
 * 服务器统一管理的图片预处理（06 号票）。
 *
 * 受控上传的 `imageOptions` 里，`role` / `usage` 是业务身份（谁被编辑、用途是什么），
 * 仍由客户端决定；`preprocessEnabled` / `targetMaxSide` / `jpegQuality` 是生产参数，
 * 团队版一律换成服务器默认值——客户端传了也丢弃，旧客户端同样受管。
 */
export function applyServerImageDefaults(
  value: unknown,
  defaults: ProductionDefaults['imagePreprocess'],
): TeamImageOptions | null {
  const normalized = normalizeTeamImageOptions(value);
  if (!normalized) return null;
  return {
    role: normalized.role,
    usage: normalized.usage,
    preprocessEnabled: defaults.enabled,
    targetMaxSide: defaults.targetMaxSide,
    jpegQuality: defaults.jpegQuality,
  };
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
