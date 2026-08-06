import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 腾讯云 COS 参考图中转。
 *
 * 背景：公司网关上游（腾讯等模型）只接受可公网访问的真实图片 URL。
 * 配置 CREATIVE_STUDIO_COS_* 后，任务提交时把参考图上传 COS 并生成
 * 预签名 GET URL 传给网关。
 *
 * 设计要点：
 * - 零新增依赖：COS XML API 签名（q-sign-algorithm=sha1）不含 region，
 *   用 node:crypto 手写签名 + fetch 直连自定义（CDN）域名即可。
 * - 对象键 = 前缀 + 内容 SHA-256 + 扩展名：天然按内容去重，跨机器幂等；
 *   HEAD 已存在则跳过上传。
 * - 预签名 GET 默认 24h 有效（CREATIVE_STUDIO_COS_URL_TTL_SEC 可配），
 *   覆盖视频任务在上游排队数小时后才取图的场景。
 * - 密钥只从环境变量读取；任何日志/错误信息都不包含签名与密钥。
 *
 * 环境变量：
 *   CREATIVE_STUDIO_COS_SECRET_ID   必填，子账号 SecretId
 *   CREATIVE_STUDIO_COS_SECRET_KEY  必填，子账号 SecretKey
 *   CREATIVE_STUDIO_COS_DOMAIN      必填，自定义域名或默认端点（不带协议），
 *                                   如 chanzhong-1314313902.linshimuye.com
 *   CREATIVE_STUDIO_COS_SIGN_HOST   可选，签名用的 host。CDN 自定义域名回源会
 *                                   把 Host 改写成源站默认端点时，设为该端点
 *                                   （如 <bucket>.cos.ap-guangzhou.myqcloud.com）；
 *                                   默认与 DOMAIN 一致
 *   CREATIVE_STUDIO_COS_PREFIX      可选，对象名前缀，默认 ref-images/
 *   CREATIVE_STUDIO_COS_URL_TTL_SEC 可选，预签名有效期秒数，默认 86400
 */

const ENV_SECRET_ID = 'CREATIVE_STUDIO_COS_SECRET_ID';
const ENV_SECRET_KEY = 'CREATIVE_STUDIO_COS_SECRET_KEY';
const ENV_DOMAIN = 'CREATIVE_STUDIO_COS_DOMAIN';
const ENV_PREFIX = 'CREATIVE_STUDIO_COS_PREFIX';
const ENV_URL_TTL = 'CREATIVE_STUDIO_COS_URL_TTL_SEC';

const ENV_SIGN_HOST = 'CREATIVE_STUDIO_COS_SIGN_HOST';

const DEFAULT_PREFIX = 'ref-images/';
const DEFAULT_URL_TTL_SEC = 86_400;
const EXISTS_CHECK_TIMEOUT_MS = 30_000;
const PUT_TIMEOUT_MS = 120_000;
// 缓存的签名 URL 提前 1h 视为过期，避免边界时刻拿到刚失效的 URL
const CACHE_EXPIRY_MARGIN_MS = 3_600_000;

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

type CosConfig = {
  secretId: string;
  secretKey: string;
  domain: string;
  signHost: string;
  prefix: string;
  urlTtlSec: number;
};

function loadCosConfig(): CosConfig | null {
  const secretId = (process.env[ENV_SECRET_ID] || '').trim();
  const secretKey = (process.env[ENV_SECRET_KEY] || '').trim();
  const rawDomain = (process.env[ENV_DOMAIN] || '').trim();
  if (!secretId || !secretKey || !rawDomain) return null;

  const domain = rawDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!domain) return null;

  // CDN 自定义域名回源时可能把 Host 改写成源站默认端点（如
  // <bucket>.cos.ap-guangzhou.myqcloud.com），此时 COS 按源站 Host 验签，
  // 签名里的 host 必须用 SIGN_HOST 指定的源站端点；默认与 DOMAIN 一致。
  const rawSignHost = (process.env[ENV_SIGN_HOST] || '').trim();
  const signHost = (rawSignHost.replace(/^https?:\/\//, '').replace(/\/+$/, '')) || domain;

  const rawPrefix = (process.env[ENV_PREFIX] || '').trim() || DEFAULT_PREFIX;
  const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;

  const ttl = Number.parseInt((process.env[ENV_URL_TTL] || '').trim(), 10);
  const urlTtlSec = Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_URL_TTL_SEC;

  return { secretId, secretKey, domain, signHost, prefix, urlTtlSec };
}

export function isCosMediaConfigured(): boolean {
  return loadCosConfig() !== null;
}

// ── COS XML API 签名（q-sign-algorithm=sha1）────────────────────────────

export type CosSignInput = {
  method: string;
  pathname: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  secretId: string;
  secretKey: string;
  startTs: number;
  endTs: number;
};

export type CosSignResult = {
  keyTime: string;
  headerList: string;
  paramList: string;
  signature: string;
};

function canonicalEntries(obj: Record<string, string>): Array<[string, string]> {
  return Object.entries(obj)
    .map(([k, v]) => [k.toLowerCase(), v] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function canonicalString(entries: Array<[string, string]>): string {
  return entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** 计算 COS 请求签名；HttpString 只包含传入的业务参数与头部（签名参数自身不参与）。 */
export function cosSign(input: CosSignInput): CosSignResult {
  const keyTime = `${input.startTs};${input.endTs}`;
  const signKey = crypto.createHmac('sha1', input.secretKey).update(keyTime).digest('hex');

  const headerEntries = canonicalEntries(input.headers);
  const paramEntries = canonicalEntries(input.params);
  const httpString = [
    input.method.toLowerCase(),
    input.pathname,
    canonicalString(paramEntries),
    canonicalString(headerEntries),
    '',
  ].join('\n');
  const stringToSign = [
    'sha1',
    keyTime,
    crypto.createHash('sha1').update(httpString).digest('hex'),
    '',
  ].join('\n');

  return {
    keyTime,
    headerList: headerEntries.map(([k]) => k).join(';'),
    paramList: paramEntries.map(([k]) => k).join(';'),
    signature: crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex'),
  };
}

function buildAuthorizationHeader(input: CosSignInput): string {
  const { keyTime, headerList, paramList, signature } = cosSign(input);
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${encodeURIComponent(input.secretId)}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=${paramList}`,
    `q-signature=${signature}`,
  ].join('&');
}

function buildSignedGetUrl(config: CosConfig, pathname: string, startTs: number, endTs: number): string {
  const { keyTime, headerList, paramList, signature } = cosSign({
    method: 'get',
    pathname,
    params: {},
    headers: { host: config.signHost },
    secretId: config.secretId,
    secretKey: config.secretKey,
    startTs,
    endTs,
  });
  const query = [
    'q-sign-algorithm=sha1',
    `q-ak=${encodeURIComponent(config.secretId)}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=${paramList}`,
    `q-signature=${signature}`,
  ].join('&');
  return `https://${config.domain}${pathname}?${query}`;
}

// ── 上传与签名 URL ─────────────────────────────────────────────────────

const signedUrlCache = new Map<string, { url: string; expiresAtMs: number }>();

export function _resetCosMediaCacheForTest(): void {
  signedUrlCache.clear();
}

function cosErrorHint(status: number): string {
  if (status === 403) {
    return '密钥无效、无 bucket 读写权限，或 CDN 回源改写了 Host（此时需把 CREATIVE_STUDIO_COS_SIGN_HOST 设为源站默认端点，如 <bucket>.cos.ap-guangzhou.myqcloud.com）。请检查 CREATIVE_STUDIO_COS_* 配置及 bucket 权限策略';
  }
  if (status === 404) {
    return 'bucket 或对象不存在，请检查 CREATIVE_STUDIO_COS_DOMAIN 是否正确';
  }
  return '请检查 CREATIVE_STUDIO_COS_* 配置与网络连通性';
}

/**
 * 把本地图片上传 COS 并返回预签名 GET URL；未配置 COS 时返回 null。
 * 上传/查询失败抛中文可操作错误（不含密钥与签名），由调用方决定回退。
 */
export async function tryUploadToCosAndSign(filePath: string, mimeType?: string): Promise<string | null> {
  const config = loadCosConfig();
  if (!config) return null;

  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeType ?? MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const buffer = await fs.promises.readFile(filePath);
  return uploadBufferAndSign(config, buffer, ext || '.jpg', mime);
}

/**
 * 内存图片（如视频抽帧的 base64）直接上传 COS 并返回预签名 GET URL；
 * 未配置 COS 时返回 null。与文件版本共用同一内容指纹去重空间。
 */
export async function tryUploadBufferToCosAndSign(buffer: Buffer<ArrayBuffer>, mimeType: string): Promise<string | null> {
  const config = loadCosConfig();
  if (!config) return null;
  return uploadBufferAndSign(config, buffer, EXT_BY_MIME[mimeType] ?? '.jpg', mimeType);
}

async function uploadBufferAndSign(config: CosConfig, buffer: Buffer<ArrayBuffer>, ext: string, mime: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const objectKey = `${config.prefix}${hash}${ext}`;
  const pathname = `/${objectKey.split('/').map(encodeURIComponent).join('/')}`;

  const cached = signedUrlCache.get(objectKey);
  if (cached && cached.expiresAtMs - CACHE_EXPIRY_MARGIN_MS > Date.now()) {
    return cached.url;
  }

  const baseUrl = `https://${config.domain}${pathname}`;
  const startTs = Math.floor(Date.now() / 1000);
  const endTs = startTs + config.urlTtlSec;
  const signBase = {
    pathname,
    params: {},
    secretId: config.secretId,
    secretKey: config.secretKey,
    startTs,
    endTs,
  };

  // 查重：对象已存在（本机历史任务或其他同事上传过）则跳过 PUT。
  // 用 GET + Range: bytes=0-0 代替 HEAD——CDN 回源会把 HEAD 改写成 GET，
  // 导致按 head 计算的签名不匹配（403 SignatureDoesNotMatch）；
  // Range 头不参与签名（q-header-list 只含 host），200/206 均视为存在。
  const existsAuth = buildAuthorizationHeader({
    ...signBase,
    method: 'get',
    headers: { host: config.signHost },
  });
  const existsRes = await fetch(baseUrl, {
    headers: { Authorization: existsAuth, Range: 'bytes=0-0' },
    signal: AbortSignal.timeout(EXISTS_CHECK_TIMEOUT_MS),
  });
  await existsRes.arrayBuffer().catch(() => undefined);

  if (existsRes.status === 404) {
    const putAuth = buildAuthorizationHeader({
      ...signBase,
      method: 'put',
      headers: { host: config.signHost, 'content-type': mime },
    });
    const putRes = await fetch(baseUrl, {
      method: 'PUT',
      headers: {
        Authorization: putAuth,
        'Content-Type': mime,
        'Content-Length': String(buffer.byteLength),
      },
      body: buffer,
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
    if (!putRes.ok) {
      const status = putRes.status;
      await putRes.arrayBuffer().catch(() => undefined);
      throw new Error(`参考图上传 COS 失败（HTTP ${status}）：${cosErrorHint(status)}`);
    }
  } else if (!existsRes.ok && existsRes.status !== 206) {
    const status = existsRes.status;
    throw new Error(`查询 COS 参考图失败（HTTP ${status}）：${cosErrorHint(status)}`);
  }

  const url = buildSignedGetUrl(config, pathname, startTs, endTs);
  signedUrlCache.set(objectKey, { url, expiresAtMs: endTs * 1000 });
  return url;
}
