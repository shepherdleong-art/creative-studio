/** 方舟直连模型合同；公司网关别名与协议不在这里处理。 */
export const SEEDREAM_5_PRO = 'doubao-seedream-5-0-pro-260628';
export const SEEDREAM_PROVIDER_ID = 'ark-seedream-5-0-pro';
export const SEEDREAM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const SEEDREAM_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3', '21:9'];

export function seedreamImageEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base.endsWith('/api/v3') ? base : `${base}/api/v3`}/images/generations`;
}

export function seedreamImageSize(size: string): string {
  if (size === 'auto') return '2K';
  if (['1K', '1.5K', '2K'].includes(size)) return size;
  // 工作台的 21:9 1K 预设略低于方舟最低像素预算，换用官方同档位尺寸。
  if (size === '1456x624') return '1512x648';
  const match = /^(\d+)x(\d+)$/.exec(size);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!match || width * height < 921600 || width * height > 4624220
    || width / height < 1 / 16 || width / height > 16) {
    throw new Error('Seedream 5.0 Pro 尺寸须在 921600–4624220 总像素内，宽高比在 1:16–16:1 内');
  }
  return size;
}
