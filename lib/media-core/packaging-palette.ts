// 包装吸色 v2（与 package-video.mjs §11 同算法同常量）：封面帧场景主色跟随 + 同色系深浅派生。
// 用途：预览路由注入 window.__palette，让 iframe 预览与正式包装管线吸色结果一致。
// 失败/无彩色场景返回兜底 #6B4A3A/#F5EDE0（与管线相同），不阻塞预览。

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export interface PackagingPalette {
  d: string;
  l: string;
}

const FALLBACK: PackagingPalette = { d: '#6B4A3A', l: '#F5EDE0' };
const SAMPLE = 96;
const CENTER_WEIGHT = 2.5;
const MIN_SATURATION = 0.12;
const MIN_SHARE = 0.05;

function toHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
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
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hn < 60) { r = c; g = x; }
  else if (hn < 120) { r = x; g = c; }
  else if (hn < 180) { g = c; b = x; }
  else if (hn < 240) { g = x; b = c; }
  else if (hn < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function toHex(r: number, g: number, b: number): string {
  const channel = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}

function isWarmHue(h: number): boolean {
  return (h >= 10 && h <= 70) || h >= 320; // 棕/橙/奶油 或 粉/红
}

/** 模板色相模式：palette.json {"hue":"any"} 不限（A，暖色平局优先）；缺省 warm 暖色限定（B/C/D）。 */
export function resolveTemplateHueMode(templateDir: string): 'any' | 'warm' {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(templateDir, 'palette.json'), 'utf-8')) as { hue?: unknown };
    return raw && raw.hue === 'any' ? 'any' : 'warm';
  } catch {
    return 'warm';
  }
}

/** 从封面帧图片提取深浅色对。算法与 package-video.mjs §11 逐行对齐，改动必须双侧同步并回归四条对照。 */
export async function extractPackagingPalette(imageAbsolutePath: string, hueMode: 'any' | 'warm'): Promise<PackagingPalette> {
  try {
    const { data, info } = await sharp(imageAbsolutePath)
      .resize(SAMPLE, SAMPLE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels < 3) return FALLBACK;

    // 4bit 色桶投票；中央 50%×50% 区域权重 ×2.5（产品多在中央）
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    let weightSum = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const pixel = i / info.channels;
      const px = (pixel % SAMPLE) / SAMPLE;
      const py = Math.floor(pixel / SAMPLE) / SAMPLE;
      const weight = px >= 0.25 && px < 0.75 && py >= 0.25 && py < 0.75 ? CENTER_WEIGHT : 1;
      weightSum += weight;
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = { n: 0, r: 0, g: 0, b: 0 }));
      bucket.n += weight;
      bucket.r += data[i] * weight;
      bucket.g += data[i + 1] * weight;
      bucket.b += data[i + 2] * weight;
    }

    const colors = [...buckets.values()].map((bucket) => {
      const r = bucket.r / bucket.n;
      const g = bucket.g / bucket.n;
      const b = bucket.b / bucket.n;
      return { share: bucket.n / weightSum, ...toHsl(r, g, b) };
    });
    const candidates = colors.filter((c) => c.s >= MIN_SATURATION && c.share >= MIN_SHARE);
    const score = (c: { share: number; s: number }) => c.share * c.s;

    let theme: { h: number; s: number; share: number } | null = null;
    if (hueMode === 'any') {
      const sorted = [...candidates].sort((a, b) => score(b) - score(a));
      theme = sorted[0] || null;
      if (theme && !isWarmHue(theme.h)) {
        const warmAlt = sorted.find((c) => isWarmHue(c.h));
        if (warmAlt && score(warmAlt) >= score(theme) * 0.85) theme = warmAlt; // 暖色平局优先
      }
    } else {
      const warm = candidates.filter((c) => isWarmHue(c.h));
      if (warm.length) theme = warm.sort((a, b) => score(b) - score(a))[0];
    }
    if (!theme) return FALLBACK;

    // 深色版：同色相，L=0.38 中深保色名，S 钳 0.25~0.5
    const sD = Math.min(0.5, Math.max(0.25, theme.s));
    const [dr, dg, db] = hslToRgb(theme.h, sD, 0.38);
    // 浅色版：同色相，L=0.88，S≤0.15，再与纯白 1:1 混合提亮
    const sL = Math.min(0.15, theme.s * 0.35);
    const [lr, lg, lb] = hslToRgb(theme.h, sL, 0.88);
    return {
      d: toHex(dr, dg, db),
      l: toHex((lr + 255) / 2, (lg + 255) / 2, (lb + 255) / 2),
    };
  } catch {
    return FALLBACK;
  }
}
