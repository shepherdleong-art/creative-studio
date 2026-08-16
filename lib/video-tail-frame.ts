import type Database from 'better-sqlite3';
import { getVideoAdapter } from './video-providers/index.ts';
import type { TailFrameCapability } from './video-providers/types.ts';

export const VIDEO_TAIL_FRAME_USAGE = 'video_tail_frame';

const UNSUPPORTED_CAPABILITY: TailFrameCapability = {
  supported: false,
  reason: 'unsupported_model',
};

const UNVERIFIED_GATEWAY_CAPABILITY: TailFrameCapability = {
  supported: false,
  reason: 'contract_unverified',
};

export interface VideoTailFrameAsset {
  id: string;
  projectId: string | null;
  role: string;
  usage: string;
  path: string;
  processedPath: string | null;
  mimeType: string;
}

export type VideoTailFrameValidation =
  | { ok: true; asset: VideoTailFrameAsset | null }
  | { ok: false; error: string };

export function validateVideoTailFrameUpload(params: {
  db: Pick<Database.Database, 'prepare'>;
  usage: string;
  role: string;
  projectId: string | null;
  fileCount: number;
}): string | null {
  if (params.usage !== VIDEO_TAIL_FRAME_USAGE) return null;
  if (params.fileCount !== 1) return '尾帧图一次只能上传 1 张';
  if (params.role !== 'input') return '尾帧图必须作为输入图片上传';
  if (!params.projectId) return '尾帧图必须属于当前项目';
  const project = params.db.prepare(`SELECT id FROM projects WHERE id = ?`).get(params.projectId);
  if (!project) return '当前项目不存在';
  return null;
}

export function getVideoTailFrameCapability(
  providerType: string,
  model: string,
): TailFrameCapability {
  const capability = getVideoAdapter(providerType)?.tailFrameCapability?.(model);
  if (capability) return capability;
  if (providerType === 'openai-video') return UNVERIFIED_GATEWAY_CAPABILITY;
  return UNSUPPORTED_CAPABILITY;
}

export function validateVideoTailFrameAsset(params: {
  db: Pick<Database.Database, 'prepare'>;
  tailImageId: string | null | undefined;
  projectId: string;
  providerType: string;
  model: string;
}): VideoTailFrameValidation {
  const tailImageId = params.tailImageId?.trim();
  if (!tailImageId) return { ok: true, asset: null };

  const capability = getVideoTailFrameCapability(params.providerType, params.model);
  if (!capability.supported) {
    return {
      ok: false,
      error: `所选视频供应商的模型 ${params.model} 不支持首尾帧，请移除尾帧图或更换供应商`,
    };
  }

  const asset = params.db.prepare(`
    SELECT id, projectId, role, usage, path, processedPath, mimeType
    FROM image_assets
    WHERE id = ?
  `).get(tailImageId) as VideoTailFrameAsset | undefined;

  if (!asset) return { ok: false, error: '尾帧图不存在' };
  if (asset.projectId !== params.projectId) {
    return { ok: false, error: '尾帧图不属于当前项目' };
  }
  if (asset.role !== 'input' || asset.usage !== VIDEO_TAIL_FRAME_USAGE) {
    return { ok: false, error: '该图片不是视频工位上传的尾帧图' };
  }

  return { ok: true, asset };
}
