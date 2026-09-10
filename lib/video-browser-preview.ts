/**
 * 浏览器预览衍生物（HEVC/10bit → H.264 副本）。
 *
 * 背景：Seedance 2.5 等公司 1080p 产物是 HEVC 10bit（yuv420p10le），浏览器
 * <video> 普遍无法解码（2026-09-08 用户反馈工作台播放器卡死，本地 VLC 正常）。
 * 策略是「原件不动、旁边放预览副本」：浏览器安全（h264 + yuv420p 8bit）的原件
 * 直接返回原件路径；否则在旁边生成 <base>.preview.mp4（libx264/yuv420p/CRF19/
 * +faststart，保留原分辨率与帧率），由 /api/videos/[...path]?preview=1 提供。
 * 下载与成片剪辑始终使用原件，衍生物只服务浏览器播放。
 * 任何一步失败都回退原件路径，绝不阻断任务链路。
 */
import fs from 'node:fs';
import path from 'node:path';
import { probeVideoMedia, runFfmpeg } from './ffmpeg.ts';

const PREVIEW_TRANSCODE_TIMEOUT_MS = 120_000;

/** 衍生物路径约定：video-xxx.mp4 → video-xxx.preview.mp4 */
export function browserPreviewPath(videoPath: string): string {
  const ext = path.extname(videoPath);
  return `${videoPath.slice(0, videoPath.length - ext.length)}.preview.mp4`;
}

/** 浏览器 <video> 可靠解码的最低共同子集：H.264 + yuv420p（8bit） */
function isBrowserPlayable(codec: string, pixelFormat: string): boolean {
  return codec === 'h264' && pixelFormat === 'yuv420p';
}

const inflight = new Map<string, Promise<string>>();

/**
 * 返回可供浏览器播放的文件路径：原件安全→原件；衍生物已存在→衍生物；
 * 否则转码生成衍生物。并发去重；失败回退原件并告警。
 */
export function ensureBrowserPreview(videoPath: string): Promise<string> {
  const existing = inflight.get(videoPath);
  if (existing) return existing;
  const task = doEnsureBrowserPreview(videoPath).finally(() => {
    inflight.delete(videoPath);
  });
  inflight.set(videoPath, task);
  return task;
}

async function doEnsureBrowserPreview(videoPath: string): Promise<string> {
  try {
    const probe = await probeVideoMedia(videoPath);
    const codec = (probe.videoCodec || '').toLowerCase();
    const pixelFormat = (probe.pixelFormat || '').toLowerCase();
    if (isBrowserPlayable(codec, pixelFormat)) return videoPath;
    // 探测失败（损坏/截断的文件）不折腾转码，直接回退原件
    if (!probe.width || !probe.height) return videoPath;

    const previewPath = browserPreviewPath(videoPath);
    if (fs.existsSync(previewPath) && fs.statSync(previewPath).size > 0) return previewPath;

    await runFfmpeg(
      [
        '-y',
        '-i', videoPath,
        '-map', '0:v:0',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-crf', '19',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        previewPath,
      ],
      { timeoutMs: PREVIEW_TRANSCODE_TIMEOUT_MS },
    );
    return previewPath;
  } catch (error) {
    console.warn(
      `[video-browser-preview] 预览衍生物生成失败，回退原件：${path.basename(videoPath)}：`,
      error instanceof Error ? error.message : error,
    );
    return videoPath;
  }
}
