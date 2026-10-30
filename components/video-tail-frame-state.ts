import type { VideoReferenceCapability } from '@/lib/video-reference-contract';

export interface VideoTailFrameCapability {
  supported: boolean;
  protocol?: string;
  reason?: 'unsupported_model' | 'contract_unverified';
}

export type TailFrameUploadState = 'idle' | 'uploading' | 'failed' | 'deleting';

export type ReferenceUploadState = TailFrameUploadState;

/** 运镜行的生成模式：首尾帧（图生视频）或全能参考。 */
export type VideoGenerationMode = 'image-to-video' | 'reference-to-video';

export type VideoReferenceAssetKind = 'image' | 'video' | 'audio';

/** 上传接口 POST /api/projects/[projectId]/video-reference-assets 的返回项。 */
export interface VideoReferenceAsset {
  id: string;
  kind: VideoReferenceAssetKind;
  filename: string;
  mimeType: string;
  byteSize: number;
  durationSec: number | null;
  url: string;
}

export interface VideoMotionRow {
  key: string;
  prompt: string;
  templateId: string;
  providerId: string;
  durationSec: number;
  multiShot: boolean;
  /** 两套草稿互不清空；提交时只带当前模式的字段。旧 fixture 缺省为首尾帧。 */
  generationMode?: VideoGenerationMode;
  tailImageId: string | null;
  tailImageUrl: string | null;
  tailImageName: string | null;
  tailUploadState: TailFrameUploadState;
  tailUploadError: string | null;
  /** 全能参考素材，顺序即提交顺序。 */
  referenceAssets?: VideoReferenceAsset[];
  referenceUploadState?: ReferenceUploadState;
  referenceUploadError?: string | null;
}

export function createVideoMotionRow(key: string, durationSec: number): VideoMotionRow {
  return {
    key,
    prompt: '',
    templateId: '',
    providerId: '',
    durationSec,
    multiShot: true,
    generationMode: 'image-to-video',
    tailImageId: null,
    tailImageUrl: null,
    tailImageName: null,
    tailUploadState: 'idle',
    tailUploadError: null,
    referenceAssets: [],
    referenceUploadState: 'idle',
    referenceUploadError: null,
  };
}

export function getVideoMotionGenerationMode(
  row: { generationMode?: VideoGenerationMode },
): VideoGenerationMode {
  return row.generationMode === 'reference-to-video' ? 'reference-to-video' : 'image-to-video';
}

export function reorderVideoReferenceAssets(
  assets: readonly VideoReferenceAsset[],
  assetId: string,
  direction: -1 | 1,
): VideoReferenceAsset[] {
  const next = [...assets];
  const index = next.findIndex((asset) => asset.id === assetId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function updateVideoMotionRowByKey(
  rows: VideoMotionRow[],
  key: string,
  update: (row: VideoMotionRow) => VideoMotionRow,
): { rows: VideoMotionRow[]; updated: boolean } {
  let updated = false;
  const nextRows = rows.map((row) => {
    if (row.key !== key) return row;
    updated = true;
    return update(row);
  });
  return { rows: nextRows, updated };
}

export function removeVideoMotionRowByKey(rows: VideoMotionRow[], key: string): VideoMotionRow[] {
  return rows.filter((row) => row.key !== key);
}

export function collectVideoMotionTailImageIds(rowGroups: Iterable<VideoMotionRow[]>): string[] {
  const ids = new Set<string>();
  for (const rows of rowGroups) {
    for (const row of rows) {
      if (row.tailImageId) ids.add(row.tailImageId);
    }
  }
  return [...ids];
}

export function collectVideoMotionReferenceAssetIds(rowGroups: Iterable<VideoMotionRow[]>): string[] {
  const ids = new Set<string>();
  for (const rows of rowGroups) {
    for (const row of rows) {
      for (const asset of row.referenceAssets ?? []) ids.add(asset.id);
    }
  }
  return [...ids];
}

const REFERENCE_KIND_LABELS: Record<VideoReferenceAssetKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};
const MIB = 1024 * 1024;

function getReferenceModeIssue(
  row: VideoMotionRow,
  capability: VideoReferenceCapability | undefined,
): string | null {
  if (row.referenceUploadState === 'uploading' || row.referenceUploadState === 'deleting') {
    return '请等待参考素材上传或移除完成';
  }
  if (row.referenceUploadState === 'failed') {
    return row.referenceUploadError || '参考素材上传失败，请重试';
  }
  if (!capability?.supported) {
    return capability?.reason === 'contract_unverified'
      ? '所选模型的全能参考协议尚未核验，请更换模型或切回首尾帧；参考素材已保留'
      : '所选模型不支持全能参考，请更换模型或切回首尾帧；参考素材已保留';
  }

  const assets = row.referenceAssets ?? [];
  if (!row.prompt.trim()) return '请填写运镜提示词';
  // No separate uploads: the server uses the shot's current image as the reference.
  if (assets.length === 0) return null;
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) {
    return '全能参考素材不能重复，请移除重复项';
  }

  for (const kind of ['image', 'video', 'audio'] as const) {
    const rule = capability[kind];
    const label = REFERENCE_KIND_LABELS[kind];
    const references = assets.filter((asset) => asset.kind === kind);
    if (references.length > rule.maxCount) {
      return `参考${label}最多 ${rule.maxCount} 份，请移除多余素材`;
    }
    for (const asset of references) {
      if (!rule.mimeTypes.includes(asset.mimeType)) {
        return `参考${label}「${asset.filename}」的格式不受支持`;
      }
      if (!Number.isFinite(asset.byteSize) || asset.byteSize < 0) {
        return `参考${label}「${asset.filename}」的文件大小无效`;
      }
      if (asset.byteSize > rule.maxBytes) {
        return `参考${label}「${asset.filename}」超过 ${Math.round(rule.maxBytes / MIB)} MiB 上限`;
      }
      if (kind === 'image') continue;
      const duration = asset.durationSec;
      if (duration === null || !Number.isFinite(duration) || duration <= 0) {
        return `参考${label}「${asset.filename}」缺少有效时长`;
      }
      if (duration < rule.minDurationSec! || duration > rule.maxDurationSec!) {
        return `参考${label}「${asset.filename}」每段须为 ${rule.minDurationSec}–${rule.maxDurationSec} 秒`;
      }
    }
    if (kind !== 'image') {
      const total = references.reduce((sum, asset) => sum + (asset.durationSec ?? 0), 0);
      if (total > rule.maxTotalDurationSec!) {
        return `参考${label}总时长不能超过 ${rule.maxTotalDurationSec} 秒`;
      }
    }
  }

  const hasAudio = assets.some((asset) => asset.kind === 'audio');
  const hasVisual = assets.some((asset) => asset.kind === 'image' || asset.kind === 'video');
  if (hasAudio && !hasVisual && !capability.allowsAudioOnly) {
    return '参考音频必须搭配图片或视频';
  }
  if (capability.maxReferenceVideoPlusOutputDurationSec !== undefined) {
    const videoTotal = assets
      .filter((asset) => asset.kind === 'video')
      .reduce((sum, asset) => sum + (asset.durationSec ?? 0), 0);
    if (videoTotal + row.durationSec > capability.maxReferenceVideoPlusOutputDurationSec) {
      return `输入视频加输出不能超过 ${capability.maxReferenceVideoPlusOutputDurationSec} 秒`;
    }
  }
  return null;
}

/** 报告为什么这一行还不能提交；referenceCapability 省略时保持首尾帧历史行为。 */
export function getVideoMotionRowIssue(
  row: VideoMotionRow,
  capability: VideoTailFrameCapability | undefined,
  referenceCapability?: VideoReferenceCapability,
): string | null {
  if (getVideoMotionGenerationMode(row) === 'reference-to-video') {
    return getReferenceModeIssue(row, referenceCapability);
  }
  if (row.tailUploadState === 'uploading' || row.tailUploadState === 'deleting') {
    return '请等待尾帧上传或移除完成';
  }
  if (row.tailUploadState === 'failed') {
    return row.tailUploadError || '尾帧上传失败，请重试';
  }
  if (!row.tailImageId) return null;
  if (!capability?.supported) {
    return capability?.reason === 'contract_unverified'
      ? '所选公司供应商的尾帧协议尚未核验，请移除尾帧或改用直连 Seedance 2.0'
      : '所选模型不支持首尾帧，请移除尾帧或更换为 Seedance 2.0';
  }
  if (!row.prompt.trim()) return '已添加尾帧，请同时填写运镜提示词';
  return null;
}
