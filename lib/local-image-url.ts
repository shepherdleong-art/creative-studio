import os from 'os';
import path from 'path';
import { dataRoot } from './data-root.ts';

export type PublicImageUrlSource = 'configured' | 'network';

export type PublicImageUrlResolution = {
  url: string;
  source: PublicImageUrlSource;
};

export function isPrivateOrLocalHttpUrl(url: string): boolean {
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;

  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first === 127
    || (first === 169 && second === 254);
}

/**
 * 把 storage/ 下的本地图片路径转成网关可拉取的 HTTP URL。
 *
 * 背景：公司中转网关（New API 类）把 images 字段原样透传给腾讯等上游，
 * 上游只接受真实 URL（且有 ~8KB 长度限制），Base64 data URL 会被 400 拒绝。
 * 本项目自身通过 /api/images/<storage 相对路径> 提供图片 HTTP 访问，
 * 只要本机地址对网关可达，就可以把本地图片变成 URL 传给网关。
 *
 * 地址默认自动探测：取第一张非内部 IPv4 网卡的地址 + 当前服务端口
 * （PORT 环境变量，默认 3000）。一般无需任何配置；特殊网络环境可用
 * CREATIVE_STUDIO_PUBLIC_BASE_URL 显式覆盖（如 http://192.168.1.10:3000）。
 *
 * 注意：自动探测要求服务监听在该网卡上——`npm run dev:win` 绑定
 * 127.0.0.1 时网关访问不到，需要用 `npm run dev`。
 *
 * 文件不在 storage/ 下或没有任何可用地址时返回 null，由调用方决定报错或兼容回退。
 */
export function resolvePublicImageUrl(filePath: string): string | null {
  return resolvePublicImageUrlWithSource(filePath)?.url ?? null;
}

export function resolvePublicImageUrlWithSource(filePath: string): PublicImageUrlResolution | null {
  const publicBase = resolvePublicBaseUrl();
  if (!publicBase) return null;

  const storageDir = path.resolve(path.join(dataRoot(), 'storage'));
  const resolved = path.resolve(filePath);
  const rel = path.relative(storageDir, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const encoded = rel.split(path.sep).map(encodeURIComponent).join('/');
  return {
    url: `${publicBase.url}/api/images/${encoded}`,
    source: publicBase.source,
  };
}

function resolvePublicBaseUrl(): PublicImageUrlResolution | null {
  const override = (process.env.CREATIVE_STUDIO_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (override) return { url: override, source: 'configured' };

  const ip = firstNonInternalIPv4();
  if (!ip) return null;
  const port = (process.env.PORT || '').trim() || '3000';
  return { url: `http://${ip}:${port}`, source: 'network' };
}

function firstNonInternalIPv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}
