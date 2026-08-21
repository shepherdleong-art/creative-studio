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
  /** 矩阵中单独坏掉的格子（'档位:比例'）；吸附命中坏格时优先在同档位找能居中裁切覆盖目标框的跨比例好格（真分辨率裁切映射），没有可裁格才同比例就近换档 */
  exclude?: string[];
  /**
   * 交付端是否按原生像素交付（只裁齐名义格比例、绝不缩放）。开启前提：
   * qiniuyun/* 逐格实测按 canonical 表原样出图；image2 实测返回更大尺寸
   *（2K 3:4 实返 1920x2560），原生交付可白赚像素，比例略偏的由交付端裁齐
   *（1K 3:4 实返 1024x1376 → 1024x1366）。缺省 false：仍规整到 job.size。
   */
  nativeDelivery?: boolean;
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
  // 实测（2026-08-21 真实任务）：返回尺寸偏离名义格但更大（2K 3:4 → 1920x2560，
  // 1K 3:4 → 1024x1376），原生像素交付白赚像素，比例偏差由交付端裁齐
  nativeDelivery: true,
};
// qiniuyun/gpt-image-2-medium（2026-08-21 真实任务逐格探测）：网关 canonical 表只收
// 1:1/3:4/4:3/16:9/9:16 五种比例（3:2、2:3、21:9 与 3K 档提交时即拒）；网关下游
// 映射有两处 bug——1K 档全部映射成 1080 类视频制式尺寸、4K 3:4 映射成 2160x2878，
// 均不满足上游「宽高 16 整除」被 BadRequestError 拒绝。其余格子逐格验证真实出图：
// 2K×5 种比例 + 4K×{1:1,4:3,16:9,9:16}（1440x1440/1920x1440/1440x1920/2560x1440/
// 1440x2560/2160x2160/2880x2160/3840x2160/2160x3840）。故放行 2K+4K 并单格排除
// 4K 3:4；排除格走裁切映射——用同档位 4K 9:16（2160x3840）生成后由
// image-output-normalize 居中裁回 3:4，真 4K 级画质（2026-08-21 与用户确认）。
// 逐格实测返回尺寸与 canonical 表一致，开启原生像素交付（nativeDelivery）。
const QINIUYUN_GPT_IMAGE_2_CAPS: CompanyModelCaps = {
  tiers: ['2K', '4K'],
  ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'],
  exclude: ['4K:3:4'],
  nativeDelivery: true,
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
  if (m.startsWith('qiniuyun/gpt-image-2')) return QINIUYUN_GPT_IMAGE_2_CAPS;
  if (m.startsWith('image2-')) return IMAGE2_CAPS;
  if (m.includes('seedream') && m.includes('pro')) return SEEDREAM_PRO_CAPS;
  if (m.includes('seedream')) return SEEDREAM_LITE_CAPS;
  return null;
}

/** 返回视频模型在公司网关的能力约束；非公司视频模型返回 null */
export function companyVideoCapsForModel(model: string): CompanyModelCaps | null {
  const m = model.toLowerCase();
  if (m.includes('kling') && m.includes('omni')) return KLING_OMNI_CAPS;
  // 文档只列了 Kling 3.0 系列的尺寸组合；其余 kling 型号按同一表做最大努力
  // 吸附（代理侧 drop_params 会兜底未知参数）。
  if (m.startsWith('kling-')) return KLING_3_CAPS;
  // doubao-seedance 未在文档尺寸表中，且实测（2026-08-12，seedance-2.0-fast
  // r2v）套用 Kling 表会被上游 400 拒绝（resolution 不合法）；省略 size，
  // 由网关/上游按首帧图默认处理。
  if (m.startsWith('doubao-seedance')) return null;
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
 * 计算吸附后的名义格子（档位+比例，含档位钳制；不做排除格替换）。
 * size 无法解析（如 'auto'）时默认 1:1，档位取 2K（不允许则就近钳制）。
 */
function snapCompanyImageCell(size: string | null | undefined, caps: CompanyModelCaps): { tier: string; ratio: string } {
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
  return { tier, ratio };
}

/**
 * 公司模型的交付尺寸（名义格子像素，2026-08-21 起公司模型按网关原生像素交付，
 * 不再放大回应用预设）：普通格子 = 生成尺寸本身；排除格 = 名义格子尺寸——
 * 生成走裁切映射的 donor 格（如 4K 9:16 的 2160x3840），交付端 normalize 按
 * 本尺寸居中裁回（如 4K 3:4 的 2160x2880），全程零放大。
 */
export function companyImageDeliverySize(size: string | null | undefined, caps: CompanyModelCaps): string {
  const cell = snapCompanyImageCell(size, caps);
  return IMAGE_SIZE_TABLE[cell.tier][cell.ratio];
}

/**
 * 把应用请求的图片尺寸吸附到公司网关白名单组合（实际提交给网关的生成尺寸）。
 * size 无法解析（如 'auto'）时默认 1:1，档位取 2K（不允许则就近钳制）。
 */
export function snapCompanyImageSize(size: string | null | undefined, caps: CompanyModelCaps): string {
  const cell = snapCompanyImageCell(size, caps);
  const { ratio } = cell;
  let { tier } = cell;

  // 单格排除：命中坏格时优先「裁切映射」——同档位找一个能完整覆盖目标框的
  // 跨比例好格（居中裁切零放大，如 qiniuyun 4K 3:4 → 4K 9:16 的 2160x3840），
  // 交付端 image-output-normalize 按 companyImageDeliverySize 居中裁回名义格子；
  // 同档位没有可裁格才回退同比例就近换档。
  if (caps.exclude?.length && caps.exclude.includes(`${tier}:${ratio}`)) {
    const donors = caps.ratios
      .filter((r) => r !== ratio && !caps.exclude!.includes(`${tier}:${r}`))
      .map((r) => ({ ratio: r, size: parseSize(IMAGE_SIZE_TABLE[tier][r]) }))
      .filter((d): d is { ratio: string; size: { width: number; height: number } } => {
        const target = parseSize(IMAGE_SIZE_TABLE[tier][ratio])!;
        return !!d.size && d.size.width >= target.width && d.size.height >= target.height;
      })
      .sort((a, b) =>
        Math.abs(Math.log(ratioValue(a.ratio) / ratioValue(ratio))) -
        Math.abs(Math.log(ratioValue(b.ratio) / ratioValue(ratio))));
    if (donors.length > 0) return IMAGE_SIZE_TABLE[tier][donors[0].ratio];
    const candidates = caps.tiers.filter((t) => !caps.exclude!.includes(`${t}:${ratio}`));
    if (candidates.length > 0) {
      tier = clampTier(tier, candidates, IMAGE_TIER_ORDER);
    }
  }

  return IMAGE_SIZE_TABLE[tier][ratio];
}

/**
 * 按源图宽高吸附公司视频模型的比例（如 '3:4'）；返回 caps.ratios 中的最接近项。
 * 用于可灵首尾帧模式的 OutputConfig.AspectRatio：实测（2026-08-17 真实任务验证）
 * 该模式下网关忽略 size、落回 16:9 默认比例，必须显式传比例。
 */
export function snapCompanyVideoAspectRatio(width: number, height: number, caps: CompanyModelCaps): string | null {
  if (!(width > 0) || !(height > 0)) return null;
  return nearestRatio(width, height, caps.ratios);
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
