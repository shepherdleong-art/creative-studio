import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FinalEditPackagingConfig } from './packaging-vars.ts';
import { PackagingError, resolvePackagingDir, resolvePackagingTemplateDir } from './packaging-runtime.ts';
import { readPackagingLayoutBundle } from './packaging-layout-manifest.ts';
import { userFontDir } from './packaging-font.ts';

/** 正式 v2 预览仅使用当前成片授权的冻结包；草稿与旧配置沿用原资源。 */
export function packagingPreviewResources(config: FinalEditPackagingConfig, resourceUrl?: string) {
  if (config.layoutRuntimeBundleVersion === 2) {
    const resolution = config.layoutResolution;
    if (!resolution || resolution.status !== 'resolved' || !resourceUrl) {
      throw new PackagingError('packaging_layout_stale', '自动布局尚未完成', 409);
    }
    const { bundleDir, manifest } = readPackagingLayoutBundle(resolution);
    if (manifest.template !== config.template) throw new PackagingError('layout_template_mismatch', '自动布局模板不一致', 409);
    // HTML 与 catalog 由服务端直接读取，同样先校验内容。
    for (const relative of [`templates/${config.template}/index.html`, 'stickers/catalog.json']) {
      verifiedBytes(bundleDir, manifest.files, relative);
    }
    return { packagingDir: bundleDir, templateDir: path.join(bundleDir, 'templates', config.template),
      fontRoot: path.join(bundleDir, 'user-fonts'), baseHref: `${resourceUrl}/${resolution.geometryManifestHash}/` };
  }
  const packagingDir = resolvePackagingDir();
  return { packagingDir, templateDir: resolvePackagingTemplateDir(packagingDir, config.template),
    fontRoot: userFontDir(), baseHref: `/api/packaging/templates/${encodeURIComponent(config.template)}/` };
}

function verifiedBytes(root: string, files: Record<string, string>, relative: string): Buffer {
  const expected = files[relative];
  if (!expected) throw new PackagingError('layout_resource_missing', '自动布局资源不存在', 404);
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw new PackagingError('layout_resource_missing', '自动布局资源已缺失', 409);
  const bytes = fs.readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new PackagingError('layout_resource_mismatch', '自动布局资源已变化，请重新完成布局', 409);
  }
  return bytes;
}

const MIME: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.ttc': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };

/** 调用方先经过成片归属授权；路径第一段必须匹配该成片当前持有的资源标识。 */
export function packagingPreviewAssetResponse(config: FinalEditPackagingConfig, segments: string[]): Response {
  const resolution = config.layoutResolution;
  if (!resolution || segments?.[0] !== resolution.geometryManifestHash
    || segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\/:\0]/.test(segment))) {
    throw new PackagingError('layout_resource_missing', '自动布局资源不存在', 404);
  }
  const { bundleDir, manifest } = readPackagingLayoutBundle(resolution);
  if (manifest.template !== config.template) throw new PackagingError('layout_template_mismatch', '自动布局模板不一致', 409);
  const relative = segments.slice(1).join('/');
  let file: string;
  if (relative.startsWith('fonts/user/')) file = `user-fonts/${relative.slice('fonts/user/'.length)}`;
  else if (relative.startsWith('fonts/')) file = relative;
  else if (relative.startsWith('stickers/')) file = relative;
  else if (relative === 'auto-layout/replay.js') file = relative;
  else file = `templates/${config.template}/${relative}`;
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new PackagingError('layout_resource_missing', '自动布局资源不存在', 404);
  // 模板内字体优先，与管线复制模板后再补共享字体一致。
  if (relative.startsWith('fonts/') && !relative.startsWith('fonts/user/') && manifest.files[`templates/${config.template}/${relative}`]) {
    file = `templates/${config.template}/${relative}`;
  }
  return new Response(new Uint8Array(verifiedBytes(bundleDir, manifest.files, file)), {
    headers: { 'Content-Type': mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
