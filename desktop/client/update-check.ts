import fs from 'node:fs';
import path from 'node:path';
import { verifyUpdateManifest } from './update-package';

/** 仅检查已签名的发布身份，不下载 ZIP 或暂停传输。 */
export async function checkClientUpdate(options: {
  installRoot: string; origin: string; manifestUrl: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<{ upToDate: boolean; releaseId: string }> {
  const origin = new URL(options.origin).origin;
  const url = new URL(options.manifestUrl);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password
    || url.hash || !url.pathname.startsWith('/client-updates/')) throw new Error('更新地址不受控');
  const publicKey = fs.readFileSync(path.join(options.installRoot, 'update-public-key.pem'), 'utf8');
  const expected = { platform: process.platform === 'win32' ? 'win32' : 'darwin',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64', trustedOrigins: [origin] };
  const current = JSON.parse(fs.readFileSync(path.join(options.installRoot, 'current.json'), 'utf8')) as {
    releaseId: string; manifest: unknown;
  };
  const installed = verifyUpdateManifest(current.manifest, publicKey, expected);
  if (current.releaseId !== installed.releaseId) throw new Error('当前客户端发布身份无效');
  const response = await options.fetch(url.href, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('更新清单读取失败，请重试');
  const latest = verifyUpdateManifest(await response.json(), publicKey, expected);
  return { upToDate: latest.releaseId === installed.releaseId, releaseId: latest.releaseId };
}
