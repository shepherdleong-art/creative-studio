/**
 * 第 4 步视频：「这条视频用的设置」的纯逻辑（08 号票）。
 *
 * 规格要求：点选一条已生成的模块 4 素材，右栏切到**这条视频当时用的设置**
 * （提示词、模型、秒数、首尾帧、智能分镜等）。这些都来自 `video_jobs` 已保存的字段，
 * 由这里转换成右栏使用的设置。
 */

import type { VideoGenerationMode } from './video-tail-frame-state.ts';
import { QINIU_KLING_4_DEFAULT_RESOLUTION, QINIU_KLING_4_MODEL } from '../lib/company-qiniu-kling-4.ts';

export type VideoJobGenerationMode = VideoGenerationMode;

/** `video_jobs` 里与「这条视频怎么生成的」相关、且界面会展示的字段。 */
export interface VideoJobRowSettingsSource {
  prompt: string;
  providerId: string;
  model: string;
  durationSec: number;
  resolution?: string | null;
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
  resolution?: string;
  templateId: string;
  multiShot: boolean;
  generationMode: VideoJobGenerationMode;
  tailImageId: string | null;
  referenceAssetIds: string[];
}

/** 从保存的任务行读出设置。`multiShot` 在库里是 0/1/NULL（未记录=关），永远按布尔归一。 */
export function savedSettingsFromJob(job: VideoJobRowSettingsSource): VideoJobSavedSettings {
  const generationMode: VideoJobGenerationMode =
    job.generationMode === 'reference-to-video' || job.generationMode === 'frames-to-video'
      ? job.generationMode : 'image-to-video';
  return {
    prompt: job.prompt ?? '',
    providerId: job.providerId ?? '',
    model: job.model ?? '',
    durationSec: job.durationSec,
    ...(job.model === QINIU_KLING_4_MODEL ? { resolution: job.resolution ?? QINIU_KLING_4_DEFAULT_RESOLUTION } : {}),
    templateId: job.templateId ?? '',
    multiShot: Number(job.multiShot ?? 0) === 1,
    generationMode,
    tailImageId: job.tailImageId ?? null,
    referenceAssetIds: [...(job.referenceAssetIds ?? [])],
  };
}

/** 左栏草稿要显示成「这条视频用的设置」时的字段摘要（右栏逐项展示）。 */
export function describeSavedSettings(saved: VideoJobSavedSettings): Array<{ label: string; value: string }> {
  return [
    { label: '模型', value: saved.model || '未记录' },
    { label: '秒数', value: `${saved.durationSec} 秒` },
    ...(saved.resolution ? [{ label: '分辨率', value: saved.resolution }] : []),
    { label: '首尾帧', value: saved.generationMode === 'frames-to-video'
      ? `多关键帧（${saved.referenceAssetIds.length} 张中间帧）`
      : saved.generationMode === 'reference-to-video'
        ? (saved.referenceAssetIds.length ? `全能参考（${saved.referenceAssetIds.length} 份素材）` : '全能参考（当前分镜图）')
        : saved.tailImageId ? '带尾帧' : '仅首帧' },
    { label: '智能分镜', value: saved.multiShot ? '开' : '关' },
  ];
}
