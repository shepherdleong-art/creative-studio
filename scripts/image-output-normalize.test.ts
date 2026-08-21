import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  normalizeGeneratedImageToNativeRatio,
  normalizeGeneratedImageToSize,
  parseImageTargetSize,
} from '../lib/image-output-normalize.ts';

assert.deepEqual(parseImageTargetSize('864x1152'), { width: 864, height: 1152 });
assert.deepEqual(parseImageTargetSize('1728x2304'), { width: 1728, height: 2304 });
assert.equal(parseImageTargetSize('auto'), null);
assert.equal(parseImageTargetSize('bad-size'), null);

const source = await sharp({
  create: {
    width: 832,
    height: 1248,
    channels: 3,
    background: '#ffffff',
  },
}).png().toBuffer();

const normalized = await normalizeGeneratedImageToSize(source, '864x1152');
assert.equal(normalized.changed, true);
assert.equal(normalized.width, 864);
assert.equal(normalized.height, 1152);
assert.match(normalized.reason || '', /832x1248 -> 864x1152/);

const metadata = await sharp(normalized.imageBuffer).metadata();
assert.equal(metadata.width, 864);
assert.equal(metadata.height, 1152);

const unchanged = await normalizeGeneratedImageToSize(normalized.imageBuffer, '864x1152');
assert.equal(unchanged.changed, false);
assert.equal(unchanged.width, 864);
assert.equal(unchanged.height, 1152);

// ── normalizeGeneratedImageToNativeRatio：原生像素交付，只裁齐比例不缩放 ──
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#d8c8b8' } }).jpeg().toBuffer();
}

// 比例已精确一致（image2 的 2K 3:4 实返 1920x2560）→ 原样交付，白赚像素
const exact = await normalizeGeneratedImageToNativeRatio(await makeJpeg(1920, 2560), '1440x1920');
assert.equal(exact.changed, false);
assert.equal(exact.width, 1920);
assert.equal(exact.height, 2560);

// 比例略偏（image2 的 1K 3:4 实返 1024x1376）→ 居中裁齐到 1024x1366，不缩放
const cropped = await normalizeGeneratedImageToNativeRatio(await makeJpeg(1024, 1376), '1024x1366');
assert.equal(cropped.changed, true);
assert.equal(cropped.width, 1024);
assert.equal(cropped.height, 1366);
assert.match(cropped.reason || '', /未缩放/);
const croppedMeta = await sharp(cropped.imageBuffer).metadata();
assert.equal(croppedMeta.width, 1024);
assert.equal(croppedMeta.height, 1366);

// donor 裁回名义格（qiniuyun 4K 3:4 用 2160x3840 生成）→ 2160x2880，不缩放
const donor = await normalizeGeneratedImageToNativeRatio(await makeJpeg(2160, 3840), '2160x2880');
assert.equal(donor.changed, true);
assert.equal(donor.width, 2160);
assert.equal(donor.height, 2880);

// 横向过宽时裁宽（16:9 源裁到 4:3 比例）：1536x1024 → 1365x1024
const wide = await normalizeGeneratedImageToNativeRatio(await makeJpeg(1536, 1024), '1920x1440');
assert.equal(wide.changed, true);
assert.equal(wide.width, 1365);
assert.equal(wide.height, 1024);

// auto / 无法解析 → 原样返回
const auto = await normalizeGeneratedImageToNativeRatio(await makeJpeg(800, 600), 'auto');
assert.equal(auto.changed, false);

console.log('image-output-normalize tests passed');
