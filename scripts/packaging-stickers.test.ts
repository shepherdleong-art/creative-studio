// 运行：node scripts/packaging-stickers.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const root = path.resolve(process.cwd(), 'packaging', 'stickers');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8')) as {
  version: number;
  sourceVersion: string;
  assets: Array<{
    style: 'show' | 'comic' | 'journal' | 'editorial';
    category: string;
    id: string;
    file: string;
    thumbnail: string;
    width: number;
    height: number;
    alpha_gt8_bbox: [number, number, number, number];
    file_bytes: number;
    sha256: string;
  }>;
};
const expectedCounts = { show: 29, comic: 28, journal: 29, editorial: 29 } as const;
const expectedCommonIds = [
  'recommend', 'good_find', 'first_sight', 'something_special', 'home_surprise', 'look_here',
  'details', 'highlight', 'key_moment', 'another_angle', 'also_here', 'now_i_see',
  'cart', 'save', 'more_details', 'take_home', 'worth_a_look', 'home_love',
  'like', 'ok', 'finger_heart', 'point_left', 'point_right', 'present',
  'arrow_right', 'arrow_left', 'oval', 'round',
].sort();

assert.equal(catalog.version, 1);
assert.equal(catalog.sourceVersion, 'V3.1');
assert.equal(catalog.assets.length, 115);
assert.ok(!JSON.stringify(catalog).includes('warm_stickers_v3'), '运行清单不得包含源目录');
assert.ok(!JSON.stringify(catalog).includes('H:\\'), '运行清单不得包含源机绝对路径');

const seen = new Set<string>();
const actualCounts = { show: 0, comic: 0, journal: 0, editorial: 0 };
let totalBytes = 0;
for (const asset of catalog.assets) {
  const key = `${asset.style}/${asset.id}`;
  assert.ok(!seen.has(key), `重复素材：${key}`);
  seen.add(key);
  actualCounts[asset.style] += 1;
  assert.ok(asset.file === `${asset.style}/${asset.id}.png`);
  assert.ok(asset.thumbnail === `thumbs/${asset.style}/${asset.id}.webp`);
  for (const relative of [asset.file, asset.thumbnail]) {
    assert.ok(!path.isAbsolute(relative) && !relative.includes('..'), `非法资源路径：${relative}`);
    const resolved = path.resolve(root, relative);
    assert.ok(resolved.startsWith(`${root}${path.sep}`), `资源路径越界：${relative}`);
  }

  const file = path.join(root, asset.file);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, asset.file_bytes, `字节数不一致：${key}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `哈希不一致：${key}`);
  const metadata = await sharp(file).metadata();
  assert.equal(metadata.format, 'png', `格式不是 PNG：${key}`);
  assert.equal(metadata.hasAlpha, true, `缺少透明通道：${key}`);
  assert.equal(metadata.channels, 4, `不是 RGBA：${key}`);
  assert.equal(metadata.width, asset.width, `宽度不一致：${key}`);
  assert.equal(metadata.height, asset.height, `高度不一致：${key}`);
  const [left, top, right, bottom] = asset.alpha_gt8_bbox;
  assert.ok(left >= 0 && top >= 0 && right > left && bottom > top && right <= asset.width && bottom <= asset.height, `包围框越界：${key}`);

  const thumbnail = await sharp(path.join(root, asset.thumbnail)).metadata();
  assert.equal(thumbnail.format, 'webp', `缩略图格式错误：${key}`);
  assert.equal(thumbnail.hasAlpha, true, `缩略图缺少透明通道：${key}`);
  assert.ok((thumbnail.width ?? 0) <= 320 && (thumbnail.height ?? 0) <= 320, `缩略图过大：${key}`);
  assert.ok(fs.statSync(path.join(root, asset.thumbnail)).size < bytes.length, `缩略图未减小体积：${key}`);
  totalBytes += bytes.length;
}
assert.deepEqual(actualCounts, expectedCounts);

const styles = ['show', 'comic', 'journal', 'editorial'] as const;
const commonIds = [...new Set(
  catalog.assets.filter((asset) => asset.id !== 'special').map((asset) => asset.id),
)].filter((id) => styles.every((style) => seen.has(`${style}/${id}`))).sort();
assert.deepEqual(commonIds, expectedCommonIds);
const specialStyles = catalog.assets.filter((asset) => asset.id === 'special').map((asset) => asset.style).sort();
assert.deepEqual(specialStyles, ['editorial', 'journal', 'show']);
for (const asset of catalog.assets) {
  assert.equal(asset.category === 'special', asset.id === 'special', `special 分类不一致：${asset.style}/${asset.id}`);
}
assert.equal(totalBytes, catalog.assets.reduce((sum, asset) => sum + asset.file_bytes, 0));
console.log(`贴纸素材测试通过：115 张，28 个共同 ID，原始 PNG 共 ${totalBytes} 字节。`);
