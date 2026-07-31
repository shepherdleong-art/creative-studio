/**
 * 公司模型网关（llm-gateway-idc.linshimuye.com，经本地 LiteLLM 代理转发）的
 * size 白名单与吸附逻辑。
 *
 * 网关只接受《小林生影_AIGC模型调用文档》第 6 节列出的「宽x高」组合；
 * 应用内的 GPT-Image-2 像素预设（如 2K 4:3 = 2304x1728）不在白名单里，
 * 直接透传会被 400 拒绝。这里按「比例就近、档位就近」把请求尺寸吸附到
 * 目标模型允许的组合上。图片下载后 image-output-normalize 仍会按 job.size
 * 居中裁切，所以最终交付尺寸不受吸附影响。
 */

import { GPT_IMAGE_2_SIZE_MAP } from './gpt-image-2-size-presets.ts';

export interface CompanyModelCaps {
  tiers: string[];
  ratios: string[];
}

/** 文档 §6.1 图片模型尺寸表：档位 → 比例 → 宽x高 */
const IMAGE_SIZE_TABLE: Record<string, Record<string, string>> = {
  '1K': { '1:1': '1024x1024', '3:4': '1024x1366', '4:3': '1366x1024', '16:9': '1820x1024', '9:16': '1024x1820', '3:2': '1536x1024', '2:3': '1024x1536', '21:9': '2390x1024' },
  '2K': { '1:1': '1440x1440', '3:4': '1440x1920', '4:3': '1920x1440', '16:9': '2560x1440', '9:16': '1440x2560', '3:2': '2160x1440', '2:3': '1440x2160', '21:9': '3360x1440' },
  '3K': { '1:1': '1920x1920', '3:4': '1920x2560', '4:3': '2560x1920', '16:9': '3414x1920', '9:16': '1920x3414', '3:2': '2880x1920', '2:3': '1920x2880', '21:9': '4480x1920' },
  '4K': { '1:1': '2160x2160', '3:4': '2160x2880', '4:3': '2880x2160', '16:9': '3840x2160', '9:16': '2160x3840', '3:2': '3240x2160', '2:3': '2160x3240', '21:9': '5040x2160' },
};

/** 文档 §6.2 视频模型尺寸表：档位 → 比例 → 宽x高 */
const VIDEO_SIZE_TABLE: Record<string, Record<string, string>> = {
  '720P': { '3:4': '720x960', '4:3': '960x720', '16:9': '1280x720', '9:16': '720x1280' },
  '1K': { '3:4': '1024x1366', '4:3': '1366x1024', '16:9': '1820x1024', '9:16': '1024x1820' },
  '4K': { '3:4': '2160x2880', '4:3': '2880x2160', '16:9': '3840x2160', '9:16': '2160x3840' },
};

const IMAGE_TIER_ORDER = ['1K', '2K', '3K', '4K'];

/** 视频档位偏好：1K 兼顾质量与成本，其次 720P，最后 4K */
const VIDEO_TIER_PREFERENCE = ['1K', '720P', '4K'];

const IMAGE2_CAPS: CompanyModelCaps = {
  tiers: ['1K', '2K', '4K'],
  ratios: ['1:1', '3:4', '4:3', '16:9', '3:2', '2:3', '21:9'], // 文档 §2.1：image2 不支持 9:16
};
const SEEDREAM_LITE_CAPS: CompanyModelCaps = {
  tiers: ['2K', '3K', '4K'],
  ratios: ['1:1', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3', '21:9'],
};
const SEEDREAM_PRO_CAPS: CompanyModelCaps = {
  tiers: ['1K', '2K'],
  ratios: ['1:1', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3', '21:9'],
};
const KLING_3_CAPS: CompanyModelCaps = {
  tiers: ['720P', '1K', '4K'],
  ratios: ['3:4', '4:3', '16:9', '9:16'],
};
const KLING_OMNI_CAPS: CompanyModelCaps = {
  tiers: ['720P', '1K'],
  ratios: ['3:4', '4:3'],
};

/** 返回图片模型在公司网关的能力约束；非公司图片模型返回 null */
export function companyImageCapsForModel(model: string): CompanyModelCaps | null {
  const m = model.toLowerCase();
  if (m.startsWith('image2-')) return IMAGE2_CAPS;
  if (m.includes('seedream') && m.includes('pro')) return SEEDREAM_PRO_CAPS;
  if (m.includes('seedream')) return SEEDREAM_LITE_CAPS;
  return null;
}

/** 返回视频模型在公司网关的能力约束；非公司视频模型返回 null */
export function companyVideoCapsForModel(model: string): CompanyModelCaps | null {
  const m = model.toLowerCase();
  if (m.includes('kling') && m.includes('omni')) return KLING_OMNI_CAPS;
  // 文档只列了 Kling 3.0 系列的尺寸组合；其余 kling 型号与 doubao-seedance
  // 未在文档中列出，按同一表做最大努力吸附（代理侧 drop_params 会兜底未知参数）。
  if (m.startsWith('kling-')) return KLING_3_CAPS;
  if (m.startsWith('doubao-seedance')) return KLING_3_CAPS;
  return null;
}

function parseSize(size: string | null | undefined): { width: number; height: number } | null {
  if (!size) return null;
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function ratioValue(ratio: string): number {
  const [w, h] = ratio.split(':').map(Number);
  return w / h;
}

/** 按比例对数距离取最近的白名单比例；并列时偏好横向（width >= height） */
function nearestRatio(width: number, height: number, ratios: string[]): string {
  const target = width / height;
  let best = ratios[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of ratios) {
    const dist = Math.abs(Math.log(target / ratioValue(candidate)));
    if (dist < bestDist - 1e-9) {
      best = candidate;
      bestDist = dist;
    } else if (Math.abs(dist - bestDist) <= 1e-9 && ratioValue(candidate) >= 1 && ratioValue(best) < 1) {
      best = candidate;
    }
  }
  return best;
}

function sizePixels(size: string): number {
  const parsed = parseSize(size);
  return parsed ? parsed.width * parsed.height : 0;
}

/** 请求尺寸若命中应用内 GPT-Image-2 预设，返回其档位名（1K/2K/4K），否则 null */
function appPresetTier(size: string): string | null {
  for (const byResolution of Object.values(GPT_IMAGE_2_SIZE_MAP)) {
    for (const [resolution, presetSize] of Object.entries(byResolution)) {
      if (presetSize === size) return resolution.toUpperCase();
    }
  }
  return null;
}

function tierRank(tier: string, order: string[]): number {
  const rank = order.indexOf(tier);
  return rank === -1 ? order.length : rank;
}

/** 把期望档位钳制到模型允许的档位：档位序就近，并列取低档（更便宜） */
function clampTier(tier: string, allowed: string[], order: string[]): string {
  const target = tierRank(tier, order);
  let best = allowed[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const dist = Math.abs(tierRank(candidate, order) - target);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    } else if (dist === bestDist && tierRank(candidate, order) < tierRank(best, order)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * 把应用请求的图片尺寸吸附到公司网关白名单组合。
 * size 无法解析（如 'auto'）时默认 1:1，档位取 2K（不允许则就近钳制）。
 */
export function snapCompanyImageSize(size: string | null | undefined, caps: CompanyModelCaps): string {
  const parsed = parseSize(size);
  const ratio = parsed
    ? nearestRatio(parsed.width, parsed.height, caps.ratios)
    : (caps.ratios.includes('1:1') ? '1:1' : caps.ratios[0]);

  let tier = size ? appPresetTier(size) : null;
  if (tier) {
    tier = caps.tiers.includes(tier) ? tier : clampTier(tier, caps.tiers, IMAGE_TIER_ORDER);
  } else if (parsed) {
    // 非预设尺寸：按像素总量就近选档，并列取低档
    const target = parsed.width * parsed.height;
    tier = caps.tiers[0];
    let bestDist = Number.POSITIVE_INFINITY;
    for (const candidate of caps.tiers) {
      const dist = Math.abs(sizePixels(IMAGE_SIZE_TABLE[candidate][ratio]) - target);
      if (dist < bestDist) {
        tier = candidate;
        bestDist = dist;
      } else if (dist === bestDist && tierRank(candidate, IMAGE_TIER_ORDER) < tierRank(tier, IMAGE_TIER_ORDER)) {
        tier = candidate;
      }
    }
  } else {
    tier = caps.tiers.includes('2K') ? '2K' : clampTier('2K', caps.tiers, IMAGE_TIER_ORDER);
  }

  return IMAGE_SIZE_TABLE[tier][ratio];
}

/**
 * 按源图宽高吸附公司视频模型的 size 组合；无法确定比例时返回 null（调用方省略 size）。
 * 档位固定按 VIDEO_TIER_PREFERENCE 取第一个允许的，不随源图分辨率上浮。
 */
export function snapCompanyVideoSize(width: number, height: number, caps: CompanyModelCaps): string | null {
  if (!(width > 0) || !(height > 0)) return null;
  const ratio = nearestRatio(width, height, caps.ratios);
  const tier = VIDEO_TIER_PREFERENCE.find((t) => caps.tiers.includes(t)) ?? caps.tiers[0];
  return VIDEO_SIZE_TABLE[tier]?.[ratio] ?? null;
}
