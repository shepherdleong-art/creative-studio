// 包装画面吸色（overlay-poster 模板）：从成片中间帧提取 2-3 个高饱和主色。
// 确定性聚类：小图降采样 → HSL 过滤 → 色相 12 桶投票 → 互斥选取 → hex。
// 失败/无合适色时返回空数组，模板回退默认配色，不阻塞包装。

import { spawnSyncHidden } from '../spawn-hidden.ts';
import sharp from 'sharp';
import { resolveFfmpegPath } from '../ffmpeg.ts';
import { writeLog } from '../logger.ts';

const HUE_BINS = 12;
const MIN_SATURATION = 0.35;
const MIN_HUE_DISTANCE_DEG = 60;
const SAMPLE_WIDTH = 96;
const SAMPLE_HEIGHT = 128;

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function toHex(r: number, g: number, b: number): string {
  const channel = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}

/** 从视频文件中间帧提取主色。返回 0-3 个 hex 颜色（按桶得票降序）。 */
export async function extractAccentColors(videoAbsolutePath: string, seekSec: number, options: { jobId?: string; projectId?: string } = {}): Promise<string[]> {
  try {
    const ffmpeg = resolveFfmpegPath();
    const grab = spawnSyncHidden(ffmpeg, [
      '-ss', Math.max(0, seekSec).toFixed(2),
      '-i', videoAbsolutePath,
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-vcodec', 'png',
      '-',
    ], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 60_000, windowsHide: true });
    if (grab.status !== 0 || !grab.stdout?.length) return [];

    const { data, info } = await sharp(grab.stdout)
      .resize(SAMPLE_WIDTH, SAMPLE_HEIGHT, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    if (channels < 3) return [];

    // 色相桶投票：票权 = 饱和度（高饱和像素对主色贡献大）
    const bins = Array.from({ length: HUE_BINS }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < data.length; i += channels) {
      const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      if (s < MIN_SATURATION || l < 0.22 || l > 0.82) continue;
      const bin = Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS));
      bins[bin].weight += s;
      bins[bin].r += data[i] * s;
      bins[bin].g += data[i + 1] * s;
      bins[bin].b += data[i + 2] * s;
    }
    const ranked = bins
      .map((bin, index) => ({ index, ...bin }))
      .filter((bin) => bin.weight > 0)
      .sort((a, b) => b.weight - a.weight);

    // 互斥选取：按桶得票降序，相邻选取的桶序号环形距离 ≥ 阈值，保证颜色有区分度
    const minBinDistance = Math.max(1, Math.round((MIN_HUE_DISTANCE_DEG / 360) * HUE_BINS));
    const chosen: Array<{ index: number; hex: string }> = [];
    for (const candidate of ranked) {
      if (chosen.length >= 3) break;
      const clash = chosen.some((existing) => {
        const diff = Math.abs(existing.index - candidate.index);
        const ring = Math.min(diff, HUE_BINS - diff);
        return ring < minBinDistance;
      });
      if (!clash) chosen.push({ index: candidate.index, hex: toHex(candidate.r / candidate.weight, candidate.g / candidate.weight, candidate.b / candidate.weight) });
    }
    const result = chosen.map((item) => item.hex);
    if (options.projectId) {
      writeLog({ jobId: options.jobId, projectId: options.projectId, level: 'info', message: `包装吸色：${result.join(' ') || '无合适主色（模板默认配色）'}` });
    }
    return result;
  } catch {
    return [];
  }
}
