// 运行：node scripts/build-sticker-assets.mjs --source "<warm_stickers_v3 目录>"
// 将原始透明 PNG、运行目录清单和轻量 WebP 缩略图装配到 packaging/stickers。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const STYLE_META = {
  show: { directory: '01_show', name: '立体综艺', count: 29 },
  comic: { directory: '02_comic', name: '圆润卡通', count: 28 },
  journal: { directory: '03_journal', name: '手帐拼贴', count: 29 },
  editorial: { directory: '04_editorial', name: '暖调杂志', count: 29 },
};
const CATEGORIES = new Set(['opening', 'explain', 'ending', 'gesture', 'annotation', 'special']);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveWithin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  requireCondition(resolved.startsWith(`${resolvedRoot}${path.sep}`), `路径越界: ${relativePath}`);
  return resolved;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const sourceArgument = argument('--source');
requireCondition(sourceArgument, '缺少 --source <warm_stickers_v3 目录>');
const sourceRoot = path.resolve(sourceArgument);
const outputRoot = argument('--output')
  ? path.resolve(argument('--output'))
  : path.resolve(process.cwd(), 'packaging', 'stickers');
const indexFile = path.join(sourceRoot, 'index.json');
requireCondition(fs.existsSync(indexFile), `素材清单不存在: ${indexFile}`);
const sourceAssets = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
requireCondition(Array.isArray(sourceAssets) && sourceAssets.length === 115, '素材清单必须恰好包含 115 张素材');

const seenKeys = new Set();
const styleCounts = Object.fromEntries(Object.keys(STYLE_META).map((style) => [style, 0]));
const catalogAssets = [];

for (const item of sourceAssets) {
  const style = item?.style;
  const id = item?.id;
  requireCondition(style in STYLE_META, `未知贴纸风格: ${style}`);
  requireCondition(/^[a-z][a-z0-9_]*$/.test(id || ''), `非法贴纸 ID: ${id}`);
  requireCondition(CATEGORIES.has(item.category), `未知贴纸分类: ${style}/${id}/${item.category}`);
  requireCondition((id === 'special') === (item.category === 'special'), `special 分类不一致: ${style}/${id}`);
  const key = `${style}/${id}`;
  requireCondition(!seenKeys.has(key), `重复贴纸: ${key}`);
  seenKeys.add(key);
  styleCounts[style] += 1;

  requireCondition(path.basename(item.file) === `${String(item.file).split('/').pop()}`, `素材路径非法: ${item.file}`);
  requireCondition(item.file.startsWith(`${STYLE_META[style].directory}/`), `素材目录与风格不一致: ${key}`);
  requireCondition(item.file.endsWith(`_${id}.png`), `素材文件名与 ID 不一致: ${key}`);
  const sourceFile = resolveWithin(sourceRoot, item.file);
  requireCondition(fs.statSync(sourceFile).isFile(), `素材不是文件: ${key}`);
  const actualHash = sha256(sourceFile);
  requireCondition(actualHash === item.sha256, `素材 SHA-256 不一致: ${key}`);
  const actualBytes = fs.statSync(sourceFile).size;
  requireCondition(actualBytes === item.file_bytes, `素材字节数不一致: ${key}`);

  const metadata = await sharp(sourceFile).metadata();
  requireCondition(metadata.format === 'png' && metadata.hasAlpha && metadata.channels === 4, `素材不是 RGBA PNG: ${key}`);
  requireCondition(metadata.width === item.width && metadata.height === item.height, `素材尺寸不一致: ${key}`);
  const bbox = item.alpha_gt8_bbox;
  requireCondition(Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite), `有效包围框非法: ${key}`);
  const [left, top, right, bottom] = bbox;
  requireCondition(left >= 0 && top >= 0 && right > left && bottom > top && right <= item.width && bottom <= item.height, `有效包围框越界: ${key}`);

  const relativeFile = `${style}/${id}.png`;
  const relativeThumbnail = `thumbs/${style}/${id}.webp`;
  const outputFile = resolveWithin(outputRoot, relativeFile);
  const outputThumbnail = resolveWithin(outputRoot, relativeThumbnail);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.mkdirSync(path.dirname(outputThumbnail), { recursive: true });
  fs.copyFileSync(sourceFile, outputFile);
  await sharp(sourceFile)
    .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, alphaQuality: 90, effort: 4 })
    .toFile(outputThumbnail);

  catalogAssets.push({
    style,
    style_name: STYLE_META[style].name,
    category: item.category,
    id,
    label: item.label,
    file: relativeFile,
    thumbnail: relativeThumbnail,
    width: item.width,
    height: item.height,
    alpha_gt8_bbox: bbox,
    file_bytes: actualBytes,
    sha256: actualHash,
  });
}

for (const [style, meta] of Object.entries(STYLE_META)) {
  requireCondition(styleCounts[style] === meta.count, `${style} 数量错误: ${styleCounts[style]}，预期 ${meta.count}`);
}

const catalog = {
  version: 1,
  sourceVersion: 'V3.1',
  styles: Object.fromEntries(Object.entries(STYLE_META).map(([id, meta]) => [id, { name: meta.name, count: meta.count }])),
  assets: catalogAssets,
};
const catalogFile = resolveWithin(outputRoot, 'catalog.json');
fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
const totalBytes = catalogAssets.reduce((sum, asset) => sum + asset.file_bytes, 0);
console.log(`贴纸素材装配完成：${catalogAssets.length} 张，原始 PNG 共 ${totalBytes} 字节。`);
console.log(`输出目录：${outputRoot}`);
