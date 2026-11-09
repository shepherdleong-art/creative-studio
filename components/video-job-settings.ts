/**
 * 第 4 步视频：「这条视频用的设置」的纯逻辑（08 号票）。
 *
 * 规格要求：点选一条已生成的模块 4 素材，右栏切到**这条视频当时用的设置**
 * （提示词、模型、秒数、首尾帧、智能分镜等）。这些都来自 `video_jobs` 已保存的字段，
 * **不改数据结构**——这里只做「把任务行读成一份设置」和「草稿跟它比一比」两件事。
 *
 * 改动后要提示「改过了，再生成会多做一条，原来那条不变」，并提供「还原」：
 * 因此需要把「基线」冻结下来（用户点「按这条设置改」那一刻的任务设置），
 * 之后任何编辑都是相对基线的差异，还原就是把基线写回草稿。
 */

export type VideoJobGenerationMode = 'image-to-video' | 'reference-to-video';

/** `video_jobs` 里与「这条视频怎么生成的」相关、且界面会展示/还原的字段。 */
export interface VideoJobRowSettingsSource {
  prompt: string;
  providerId: string;
  model: string;
  durationSec: number;
  templateId: string | null;
  multiShot?: number | null;
  generationMode?: string | null;
  tailImageId?: string | null;
  referenceAssetIds?: readonly string[] | null;
}

export interface VideoJobSavedSettings {
  prompt: string;
  providerId: string;
  model: string;
  durationSec: number;
  templateId: string;
  multiShot: boolean;
  generationMode: VideoJobGenerationMode;
  tailImageId: string | null;
  referenceAssetIds: string[];
}

/** 从保存的任务行读出设置。`multiShot` 在库里是 0/1/NULL（未记录=关），永远按布尔归一。 */
export function savedSettingsFromJob(job: VideoJobRowSettingsSource): VideoJobSavedSettings {
  const generationMode: VideoJobGenerationMode = job.generationMode === 'reference-to-video'
    ? 'reference-to-video'
    : 'image-to-video';
  return {
    prompt: job.prompt ?? '',
    providerId: job.providerId ?? '',
    model: job.model ?? '',
    durationSec: job.durationSec,
    templateId: job.templateId ?? '',
    multiShot: Number(job.multiShot ?? 0) === 1,
    generationMode,
    tailImageId: job.tailImageId ?? null,
    referenceAssetIds: [...(job.referenceAssetIds ?? [])],
  };
}

/** 草稿侧用于比较的字段（左栏编辑器的第一行 + 该分镜的管辖信息）。 */
export interface VideoSettingsDraft {
  prompt: string;
  providerId: string;
  durationSec: number;
  templateId: string | null;
  multiShot: boolean;
  generationMode: VideoJobGenerationMode;
  tailImageId: string | null;
  referenceAssetIds?: readonly string[] | null;
}

function sameIdList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

/**
 * 草稿与基线是否有差异。逐字段比较，**不做归一化放宽**（例如秒数 5 与 6 就是不同），
 * 否则「改过了」的提示会在真的改了的时候不出现。
 *
 * 唯一被抹平的是「空值形态」：`templateId` 的 `null` 与 `''` 在界面里都代表
 * 「自定义」（模板下拉的空选项），不构成改动。
 */
export function videoSettingsDiffer(
  saved: VideoJobSavedSettings,
  draft: VideoSettingsDraft,
): boolean {
  if (saved.prompt.trim() !== draft.prompt.trim()) return true;
  if (saved.providerId !== draft.providerId) return true;
  if (saved.durationSec !== draft.durationSec) return true;
  if (saved.templateId !== (draft.templateId ?? '')) return true;
  if (saved.multiShot !== draft.multiShot) return true;
  if (saved.generationMode !== draft.generationMode) return true;
  if (saved.generationMode === 'image-to-video') {
    if (saved.tailImageId !== draft.tailImageId) return true;
  } else if (!sameIdList(saved.referenceAssetIds, draft.referenceAssetIds ?? [])) {
    return true;
  }
  return false;
}

/** 改动提示的固定文案（验收逐字比对这句话）。 */
export const VIDEO_SETTINGS_CHANGED_HINT = '改过了，再生成会多做一条，原来那条不变';

/** 左栏草稿要显示成「这条视频用的设置」时的字段摘要（右栏逐项展示）。 */
export function describeSavedSettings(saved: VideoJobSavedSettings): Array<{ label: string; value: string }> {
  return [
    { label: '模型', value: saved.model || '未记录' },
    { label: '秒数', value: `${saved.durationSec} 秒` },
    { label: '首尾帧', value: saved.generationMode === 'reference-to-video' ? '全能参考（当前分镜图）' : (saved.tailImageId ? '带尾帧' : '仅首帧') },
    { label: '智能分镜', value: saved.multiShot ? '开' : '关' },
  ];
}
